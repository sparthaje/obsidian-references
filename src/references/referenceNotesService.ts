/*
 * Part 2 of the "Links" references feature: turn a clicked reference into a
 * durable markdown note, wire a wikilink from the citing paper to it, and keep
 * the citation graph deduplicated.
 *
 * Identity (see docs/REFERENCE-NOTES-PLAN.md): the same work shows up as an
 * arXiv preprint, a publisher PDF, a personal-site copy — the id differs or is
 * missing across venues, but the title + first-author surname stays stable. So
 * the canonical key is slug(title + "-" + surname); arXiv/DOI are stored as
 * secondary signals (and could drive a future merge) but are not the filename.
 */
import { Notice, TFile, TFolder } from 'obsidian';
import type AnnotatorPlugin from 'main';
import type { PageReference, PdfLike } from 'references/extractReferences';
import { extractPdfTitle } from 'references/extractTitle';

/** Raw identity signals pulled out of a reference's full text, for the frontmatter. */
interface ReferenceSignals {
    title: string;
    surname: string;
    year?: string;
    arxiv?: string;
    doi?: string;
}

const MAX_KEY_LENGTH = 120;

/** lowercase, strip diacritics, non-alphanumerics → hyphens, collapse + trim. */
export function slug(input: string): string {
    return input
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '') // combining diacritics
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Best-effort surname of the first author from a reference's full text.
 * Handles "Vaswani, A.", "A. Vaswani", "Mathilde Caron, …", "Vaswani et al.".
 */
export function firstAuthorSurname(fullText: string): string {
    const body = fullText.replace(/^\[\d+\]\s*/, '').trim();
    // The first author is whatever precedes the first comma or " and ".
    const segment = body.split(/,|\sand\s/i)[0].trim();
    const tokens = segment.split(/\s+/).filter(t => {
        const clean = t.replace(/\./g, '');
        // drop initials ("C.", "X.Y."), "et"/"al", and non-alphabetic noise
        return clean.length > 1 && !/^(et|al)$/i.test(clean) && /[A-Za-z]/.test(clean);
    });
    if (tokens.length === 0) return '';
    // In both "Vaswani, A." (comma split leaves "Vaswani") and "A. Vaswani" the
    // surname is the last remaining token.
    return tokens[tokens.length - 1].replace(/[^A-Za-z-]/g, '');
}

export function extractSignals(ref: PageReference): ReferenceSignals {
    const text = ref.fullText || ref.title;
    const arxiv = /arxiv:\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i.exec(text)?.[1];
    const doi = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/.exec(text)?.[1];
    const year = /\b(?:19|20)\d{2}\b/.exec(text)?.[0];
    return {
        title: ref.title.trim(),
        surname: firstAuthorSurname(text),
        year,
        arxiv,
        doi
    };
}

/** Canonical, filename-safe key for a work. */
export function canonicalKey(ref: PageReference): string {
    const { title, surname } = extractSignals(ref);
    const titleSlug = slug(title);
    const base = surname ? `${titleSlug}-${slug(surname)}` : titleSlug;
    return base.slice(0, MAX_KEY_LENGTH).replace(/-+$/g, '') || 'untitled';
}

function yamlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export default class ReferenceNotesService {
    private plugin: AnnotatorPlugin;
    // Guards against re-entrant renames and re-running per file each session.
    private renaming = new Set<string>();
    private retitledThisSession = new Set<string>();

    constructor(plugin: AnnotatorPlugin) {
        this.plugin = plugin;
    }

    private get folder(): string {
        return (this.plugin.settings.referenceNotesSettings?.folder || 'references').replace(/\/+$/, '');
    }

    /**
     * Entry point for the panel's "open backlink" button. Creates-or-finds the
     * reference note, links it from the citing paper, and opens it.
     */
    async openReferenceNote(ref: PageReference, citingNotePath: string | null): Promise<void> {
        try {
            const key = canonicalKey(ref);
            const note = (await this.findExistingNote(key)) ?? (await this.createStubNote(key, ref));
            if (!note) return;
            if (citingNotePath) await this.ensureWikilink(citingNotePath, note, ref);
            await this.openNote(note);
        } catch (e) {
            this.plugin.log('Links: failed to open reference note', e);
            new Notice('Links: could not open reference note (see console)');
        }
    }

    /** Find an existing note for `key`: by path first, then by stored canonical-key. */
    private async findExistingNote(key: string): Promise<TFile | null> {
        const direct = this.plugin.app.vault.getAbstractFileByPath(`${this.folder}/${key}.md`);
        if (direct instanceof TFile) return direct;

        // A note that was retitled (see retitle-on-target) no longer lives at
        // `${key}.md`, so fall back to scanning the references folder for the
        // canonical-key we stamped into its frontmatter.
        const folder = this.plugin.app.vault.getAbstractFileByPath(this.folder);
        if (!(folder instanceof TFolder)) return null;
        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                const fm = this.plugin.app.metadataCache.getFileCache(child)?.frontmatter;
                if (fm?.['canonical-key'] === key) return child;
            }
        }
        return null;
    }

    private async ensureFolder(): Promise<void> {
        const path = this.folder;
        if (!path) return;
        if (!this.plugin.app.vault.getAbstractFileByPath(path)) {
            await this.plugin.app.vault.createFolder(path).catch(() => {
                /* already exists / race */
            });
        }
    }

    private async createStubNote(key: string, ref: PageReference): Promise<TFile | null> {
        await this.ensureFolder();
        const signals = extractSignals(ref);
        const fm: string[] = ['---', 'annotation-target: ', `title: ${yamlString(signals.title)}`];
        if (signals.year) fm.push(`year: ${signals.year}`);
        if (signals.arxiv) fm.push(`arxiv: ${signals.arxiv}`);
        if (signals.doi) fm.push(`doi: ${yamlString(signals.doi)}`);
        fm.push(`canonical-key: ${yamlString(key)}`);
        fm.push('aliases:', `  - ${yamlString(signals.title)}`);
        fm.push(`references-citation: ${yamlString(ref.fullText || signals.title)}`);
        fm.push('---', '', `# ${signals.title}`, '');

        const path = `${this.folder}/${key}.md`;
        const created = await this.plugin.app.vault.create(path, fm.join('\n'));
        return created instanceof TFile ? created : null;
    }

    private linkAlreadyPresent(data: string, note: TFile): boolean {
        const targets = [note.basename, note.path.replace(/\.md$/, '')];
        return targets.some(t => {
            const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\[\\[\\s*${escaped}\\s*(\\||\\]|#)`).test(data);
        });
    }

    /**
     * Idempotently add `- [N] [[ref note|title]]` under a `## References`
     * heading in the citing paper's note. The citing note is usually rendered
     * as a PDF (annotator view), so we edit the file via vault.process rather
     * than the editor.
     */
    private async ensureWikilink(citingNotePath: string, note: TFile, ref: PageReference): Promise<void> {
        const citing = this.plugin.app.vault.getAbstractFileByPath(citingNotePath);
        if (!(citing instanceof TFile)) return;
        if (citing.path === note.path) return; // don't link a note to itself

        const link = this.plugin.app.fileManager.generateMarkdownLink(note, citing.path, undefined, ref.title);
        const bullet = `- [${ref.number}] ${link}`;

        await this.plugin.app.vault.process(citing, data => {
            if (this.linkAlreadyPresent(data, note)) return data;
            return addBulletToReferences(data, bullet);
        });
    }

    private async openNote(note: TFile): Promise<void> {
        const leaf = this.plugin.app.workspace.getLeaf('tab');
        await leaf.openFile(note);
    }

    /**
     * Called when a PDF finishes loading in an annotator view. Extracts the
     * paper's title from the PDF and renames the backing note to it, so setting
     * an annotation-target and opening the paper makes the tab/file show the
     * real title. renameFile rewrites inbound wikilinks; the extracted title is
     * also stamped into the note's `title` frontmatter for dedup/reference.
     *
     * Applies to ANY annotation note (not just reference stubs). Runs at most
     * once per file per session, and never re-renames a note already named
     * after its title — toggle off via settings.referenceNotesSettings.
     */
    async retitleFromPdf(annotationFile: string, pdf: PdfLike): Promise<void> {
        if (this.plugin.settings.referenceNotesSettings?.retitleOnTarget === false) return;
        const file = this.plugin.app.vault.getAbstractFileByPath(annotationFile);
        if (!(file instanceof TFile)) return;
        if (this.renaming.has(file.path) || this.retitledThisSession.has(file.path)) return;
        this.retitledThisSession.add(file.path);

        let title: string | null = null;
        try {
            title = await extractPdfTitle(pdf);
        } catch (e) {
            this.plugin.log('Links: failed to extract PDF title', e);
        }
        if (!title) return;

        // Record the title in frontmatter (don't clobber an existing one).
        try {
            await this.plugin.app.fileManager.processFrontMatter(file, fm => {
                if (!fm.title) fm.title = title;
            });
        } catch (e) {
            this.plugin.log('Links: failed to write title frontmatter', e);
        }

        const newSlug = slug(title).slice(0, MAX_KEY_LENGTH).replace(/-+$/g, '');
        if (!newSlug || file.basename === newSlug) return;

        const newPath = await this.uniquePath(newSlug);
        this.renaming.add(file.path);
        try {
            await this.plugin.app.fileManager.renameFile(file, newPath);
        } catch (e) {
            this.plugin.log('Links: failed to retitle note from PDF', e);
        } finally {
            this.renaming.delete(file.path);
        }
    }

    private async uniquePath(baseSlug: string): Promise<string> {
        let candidate = `${this.folder}/${baseSlug}.md`;
        let n = 2;
        while (this.plugin.app.vault.getAbstractFileByPath(candidate)) {
            candidate = `${this.folder}/${baseSlug}-${n}.md`;
            n++;
        }
        return candidate;
    }
}

/** Insert a bullet into (or create) a `## References` section. */
export function addBulletToReferences(data: string, bullet: string): string {
    const headingRe = /^##\s+References\s*$/m;
    const m = headingRe.exec(data);
    if (!m) {
        const sep = data.length === 0 || data.endsWith('\n') ? '' : '\n';
        return `${data}${sep}\n## References\n\n${bullet}\n`;
    }
    const afterHeading = m.index + m[0].length;
    const rest = data.slice(afterHeading);
    const nextHeading = /\n#{1,6}\s/.exec(rest);
    const insertAt = nextHeading ? afterHeading + nextHeading.index : data.length;
    const section = data.slice(afterHeading, insertAt).replace(/\s*$/, '');
    return `${data.slice(0, afterHeading)}${section}\n${bullet}\n${data.slice(insertAt)}`;
}
