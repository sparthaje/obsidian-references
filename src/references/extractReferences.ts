/*
 * Core logic for the "References on this page" panel.
 *
 * Research PDFs encode in-text citations (e.g. `[12]`) as internal PDF link
 * annotations whose destination jumps to the matching entry in the
 * bibliography. This module, given the page the reader is currently looking
 * at, follows those links into the references section and reads the reference
 * entry text sitting at each destination — entirely from inside the PDF, no
 * network lookups.
 *
 * It depends only on the small structural subset of the pdf.js API defined
 * below (PdfLike / PageLike / ...), so it is agnostic to the pdf.js version
 * and can be unit-tested in Node against real PDFs and reused in-plugin with
 * `PDFViewerApplication.pdfDocument`.
 */

export interface TextItemLike {
    str: string;
    // pdf.js text item transform: [a, b, c, d, e, f]; e=x, f=y (PDF coords, origin bottom-left)
    transform?: number[];
    width?: number;
    height?: number;
}

export interface AnnotationLike {
    subtype?: string;
    // internal links carry a destination (named string or explicit array); external links carry `url`
    dest?: string | unknown[] | null;
    url?: string;
    rect?: number[];
}

export interface PageLike {
    getAnnotations(opts?: unknown): Promise<AnnotationLike[]>;
    getTextContent(opts?: unknown): Promise<{ items: TextItemLike[] }>;
    // MediaBox [x0, y0, x1, y1]
    view?: number[];
}

export interface PdfLike {
    getPage(pageNumber: number): Promise<PageLike>;
    getDestination(id: string): Promise<unknown[] | null>;
    getPageIndex(ref: unknown): Promise<number>;
}

export interface PageReference {
    id: string; // stable de-dup/identity key within the document
    number: number | null; // the [N] of a numbered reference; null for author–year bibliographies
    label: string; // panel chip text: "19" for numbered, "Vaswani et al. 2017" for author–year
    title: string; // best-effort extracted title (falls back to the full text)
    fullText: string; // the whole reference entry, cleaned
    destPage: number; // 1-based page where the entry lives (for "jump to reference")
}

interface ResolvedTarget {
    pageIndex: number; // 0-based
    left: number | null;
    top: number | null;
}

interface NormItem {
    x: number;
    y: number;
    w: number;
    str: string;
}

interface Line {
    x: number; // left-most x of the line
    y: number; // baseline y
    text: string;
    col: number; // 0 = left/only column, 1 = right column
}

interface Marker {
    number: number | null; // [N] when the bibliography is numbered, else null (author–year)
    lineIndex: number; // index into the ordered line list
    x: number;
    y: number;
    col: number;
}

interface PageModel {
    orderedLines: Line[];
    markers: Marker[];
    midX: number;
    twoColumn: boolean;
}

const LINE_TOL = 3; // points; items within this y-distance are on the same line
const INDENT_TOL = 4; // points; lines within this of a column's left edge count as "flush left"

/** Resolve a link annotation's destination to a page index + target coordinates. */
export async function resolveDestination(pdf: PdfLike, dest: string | unknown[]): Promise<ResolvedTarget | null> {
    try {
        let explicit: unknown[] | null;
        if (typeof dest === 'string') {
            explicit = await pdf.getDestination(dest);
        } else {
            explicit = dest;
        }
        if (!Array.isArray(explicit) || explicit.length === 0) return null;
        const pageIndex = await pdf.getPageIndex(explicit[0]);
        const { left, top } = readDestCoords(explicit);
        return { pageIndex, left, top };
    } catch {
        return null;
    }
}

/** Extract (left, top) from an explicit destination array, based on its fit type. */
function readDestCoords(explicit: unknown[]): { left: number | null; top: number | null } {
    const fit = (explicit[1] as { name?: string } | undefined)?.name;
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    switch (fit) {
        case 'XYZ':
            return { left: num(explicit[2]), top: num(explicit[3]) };
        case 'FitH':
        case 'FitBH':
            return { left: null, top: num(explicit[2]) };
        case 'FitV':
        case 'FitBV':
            return { left: num(explicit[2]), top: null };
        case 'FitR':
            return { left: num(explicit[2]), top: num(explicit[5]) };
        default:
            return { left: null, top: null };
    }
}

function normalizeItems(items: TextItemLike[]): NormItem[] {
    const out: NormItem[] = [];
    for (const it of items) {
        if (!it.transform || !it.str || it.str.length === 0) continue;
        out.push({ x: it.transform[4], y: it.transform[5], w: it.width ?? 0, str: it.str });
    }
    return out;
}

/** Cluster items into text lines (within a single column), ordered top-to-bottom. */
function clusterLines(items: NormItem[], col: number): Line[] {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: { x: number; y: number; parts: NormItem[] }[] = [];
    for (const it of sorted) {
        const line = lines.find(l => Math.abs(l.y - it.y) <= LINE_TOL);
        if (line) {
            line.parts.push(it);
            line.x = Math.min(line.x, it.x);
        } else {
            lines.push({ x: it.x, y: it.y, parts: [it] });
        }
    }
    return lines.map(l => ({
        x: l.x,
        y: l.y,
        col,
        text: cleanText(
            l.parts
                .sort((a, b) => a.x - b.x)
                .map(p => p.str)
                .join(' ')
        )
    }));
}

export function cleanText(s: string): string {
    return s
        .replace(/\s+/g, ' ')
        .replace(/-\s+(?=[a-z])/g, '') // join words hyphenated across line breaks
        .trim();
}

/**
 * Build a positional model of a (references) page: ordered lines + the [N]
 * markers that begin each reference entry. Handles one- and two-column layouts.
 */
export function buildPageModel(items: TextItemLike[], pageWidth: number): PageModel {
    const norm = normalizeItems(items);
    const midX = pageWidth / 2;

    const leftItems = norm.filter(i => i.x < midX);
    const rightItems = norm.filter(i => i.x >= midX);
    const total = norm.length || 1;
    // True two-column layouts have an empty central gutter: almost no text item
    // crosses the page midline. A full-width single column instead has a text
    // item spanning the middle on nearly every line, so the fraction of
    // "straddlers" cleanly separates the two — measured across real one- and
    // two-column papers it sits near 0–2% for two-column vs 12–24% for single,
    // so an 8% cutoff discriminates with wide margin and tolerates the handful
    // of full-width section headers, captions, and equations a two-column body
    // page carries. (Requiring both columns to be text-heavy, as a stricter
    // rule once did, wrongly demoted pages where one column is mostly a figure.)
    const straddling = norm.filter(i => i.x < midX && i.x + i.w > midX).length;
    const twoColumn =
        straddling <= Math.max(2, total * 0.08) && leftItems.length > total * 0.1 && rightItems.length > total * 0.1;

    let orderedLines: Line[];
    if (twoColumn) {
        orderedLines = [...clusterLines(leftItems, 0), ...clusterLines(rightItems, 1)];
    } else {
        orderedLines = clusterLines(norm, 0);
    }

    return { orderedLines, markers: detectMarkers(orderedLines), midX, twoColumn };
}

/**
 * Find the lines that begin reference entries. Two bibliography styles exist:
 *
 *  - Numbered ("[19] Dosovitskiy …"): each entry starts with a `[N]` marker.
 *  - Author–year ("Dosovitskiy, A., … 2020."): no marker; instead entries use a
 *    *hanging indent* — the first line of each entry sits flush at the column's
 *    left edge while continuation lines are indented further right.
 *
 * We prefer the numbered markers when there are clearly several of them, and
 * otherwise fall back to hanging-indent detection. This keeps a stray "[3]"
 * appearing inside an author–year entry from masquerading as the only marker.
 */
function detectMarkers(lines: Line[]): Marker[] {
    const numbered: Marker[] = [];
    lines.forEach((line, lineIndex) => {
        const m = /^\[(\d+)\]/.exec(line.text);
        if (m) numbered.push({ number: parseInt(m[1], 10), lineIndex, x: line.x, y: line.y, col: line.col });
    });
    if (numbered.length >= 2) return numbered;

    const hanging = detectHangingIndentMarkers(lines);
    return hanging.length > numbered.length ? hanging : numbered;
}

/**
 * Detect entry starts in an author–year bibliography by its hanging indent: per
 * column, the entry's first line is flush with the column's left edge and the
 * rest are indented. Requires a meaningful share of indented (continuation)
 * lines so ordinary body text — where almost every line is flush left — is not
 * mistaken for a bibliography when a non-citation link happens to point at it.
 */
function detectHangingIndentMarkers(lines: Line[]): Marker[] {
    const markers: Marker[] = [];
    for (const col of [0, 1]) {
        const colLines = lines.map((l, i) => ({ l, i })).filter(o => o.l.col === col);
        if (colLines.length < 3) continue;
        const minX = Math.min(...colLines.map(o => o.l.x));
        const indented = colLines.filter(o => o.l.x > minX + INDENT_TOL);
        // A real hanging-indent bibliography has many continuation lines; body
        // text (flush-left or first-line-indented paragraphs) has very few.
        if (indented.length < colLines.length * 0.25) continue;
        for (const { l, i } of colLines) {
            if (l.x <= minX + INDENT_TOL && looksLikeEntryStart(l.text)) {
                markers.push({ number: null, lineIndex: i, x: l.x, y: l.y, col });
            }
        }
    }
    return markers.sort((a, b) => a.lineIndex - b.lineIndex);
}

/** A reference entry begins with an author name — a capital letter or initial. */
function looksLikeEntryStart(text: string): boolean {
    return text.length >= 6 && /^[A-Z\p{Lu}]/u.test(text);
}

/**
 * A short "Surname [et al.] Year" label for an author–year reference, used as
 * the panel chip and backlink bullet (numbered references just use their [N]).
 * Mirrors the author parsing in referenceNotesService but adds the year.
 */
export function authorYearLabel(fullText: string): string {
    const body = fullText.replace(/^\[\d+\]\s*/, '').trim();
    const year = /\b(?:19|20)\d{2}[a-z]?\b/.exec(body)?.[0] ?? '';
    // The author block is everything up to the first real sentence break (the
    // title). Don't split after a lone initial ("A. Vaswani").
    const authorBlock = body.split(/(?<!\b[A-Z])\.\s+/)[0] ?? body;
    const firstAuthor = authorBlock.split(/,|\sand\s/i)[0].trim();
    const tokens = firstAuthor.split(/\s+/).filter(t => t.replace(/\./g, '').length > 1 && /[A-Za-z]/.test(t));
    const surname = tokens.length ? tokens[tokens.length - 1].replace(/[^A-Za-z'-]/g, '') : '';
    const multiAuthor = /\bet\s+al\b/i.test(authorBlock) || /,|\sand\s/i.test(authorBlock);
    const name = surname ? (multiAuthor ? `${surname} et al.` : surname) : 'Reference';
    return year ? `${name} ${year}` : name;
}

/** The full text of the reference entry beginning at markers[markerIdx]. */
export function extractEntryText(model: PageModel, markerIdx: number): string {
    const start = model.markers[markerIdx].lineIndex;
    const end = markerIdx + 1 < model.markers.length ? model.markers[markerIdx + 1].lineIndex : model.orderedLines.length;
    return cleanText(
        model.orderedLines
            .slice(start, end)
            .map(l => l.text)
            .join(' ')
    );
}

/** Find which reference marker a citation's destination points at. Returns -1 if none. */
export function findEntryAt(model: PageModel, target: ResolvedTarget): number {
    if (model.markers.length === 0) return -1;
    let candidates = model.markers.map((m, i) => ({ m, i }));

    // In two-column layouts, use the destination's x to pick the correct column.
    if (model.twoColumn && target.left != null) {
        const col = target.left < model.midX ? 0 : 1;
        const sameCol = candidates.filter(c => c.m.col === col);
        if (sameCol.length > 0) candidates = sameCol;
    }

    if (target.top == null) {
        // No vertical hint: best we can do is the first marker in the (column) set.
        return candidates[0].i;
    }
    let best = candidates[0];
    let bestDist = Math.abs(best.m.y - target.top);
    for (const c of candidates) {
        const d = Math.abs(c.m.y - target.top);
        if (d < bestDist) {
            best = c;
            bestDist = d;
        }
    }
    return best.i;
}

/**
 * Best-effort extraction of the paper title from a full reference entry.
 * Reference entries follow "[N] Authors. Title. Venue, Year." reasonably often;
 * we strip the [N], skip the author block, and take the text up to the venue.
 * Falls back to the full (post-[N]) text when unsure — the panel shows the full
 * entry alongside, so a poor guess is never lossy.
 */
export function guessTitle(fullText: string): string {
    const body = fullText.replace(/^\[\d+\]\s*/, '').trim();
    if (!body) return fullText;

    // Split into sentence-ish chunks on ". ", but never right after a lone initial
    // ("C. ", "E. ") — while still splitting after words that end in a capital ("…3D. ").
    const chunks = body.split(/(?<!\b[A-Z])\.\s+/).map(c => c.trim()).filter(Boolean);
    if (chunks.length === 0) return body;

    // Lowercase title function words ("via", "for", "of", …). Author name-lists
    // essentially never contain these; titles almost always do — even Title-Cased
    // titles keep them lowercase. Case-sensitive so uppercase initials ("A.") are safe.
    const TITLE_FUNCTION_WORD =
        /\b(a|an|the|of|for|via|with|without|on|to|in|into|from|through|using|by|as|at|toward|towards|under|over|between|across|about|after|before|against)\b/;
    const looksLikeAuthors = (c: string): boolean => {
        if (TITLE_FUNCTION_WORD.test(c)) return false;
        const words = c.replace(/^\[\d+\]\s*/, '').split(/\s+/).filter(Boolean);
        if (words.length < 2) return false;
        const capitalized = words.filter(w => /^[A-Z]/.test(w)).length;
        const hasSeparator = /,/.test(c) || /\band\b/.test(c) || /\bet\s+al/.test(c);
        // Author lists ("C. Chi, ... S. Song" and "Mathilde Caron, ... Armand Joulin")
        // are almost all capitalized tokens separated by commas / "and".
        return hasSeparator && capitalized / words.length > 0.6;
    };
    const looksLikeVenue = (c: string): boolean =>
        /^(in\b|proc\b|proceedings\b|advances\b|journal\b|trans\.|transactions\b|conference\b|workshop\b|arxiv\b|preprint\b)/i.test(
            c
        ) || /\b(19|20)\d{2}\b/.test(c) || /\bPMLR\b|\bNeurIPS\b|\bICML\b|\bICLR\b|\bCVPR\b|\bvol\.|\bpp\.|\bpages\b/.test(c);

    let i = 0;
    // Skip leading author chunk(s).
    while (i < chunks.length && looksLikeAuthors(chunks[i])) i++;
    // Accumulate title chunks until we reach the venue.
    const titleParts: string[] = [];
    while (i < chunks.length && !looksLikeVenue(chunks[i])) {
        const chunk = chunks[i];
        // Stop before trailing volume/number noise (e.g. ". 1" or ". 8(9):9").
        if (titleParts.length >= 1 && (/^[\d(]/.test(chunk) || (chunk.match(/[A-Za-z]{2,}/g) || []).length < 2)) break;
        titleParts.push(chunk);
        i++;
        if (titleParts.length >= 2) break; // titles rarely span >2 of these chunks
    }
    let title = titleParts.join('. ').trim();
    title = title.replace(/[.,;]+$/, '').trim();

    // Sanity: a real title has a few words; otherwise fall back to the full body.
    if (title.split(/\s+/).length < 2 || title.length > 300) return body;
    return title;
}

const pageWidthOf = (page: PageLike, items: TextItemLike[]): number => {
    if (page.view && page.view.length >= 4) return page.view[2] - page.view[0];
    let max = 0;
    for (const it of items) if (it.transform) max = Math.max(max, it.transform[4] + (it.width ?? 0));
    return max || 612; // US Letter fallback
};

/**
 * Reading-order rank of a citation from its annotation rectangle on the current
 * page: by column first (left before right, two-column pages only), then
 * top-to-bottom. Smaller = earlier. Citations without a rect sort to the end.
 */
function citationOrder(rect: number[] | undefined, twoColumn: boolean, midX: number): number {
    if (!rect || rect.length < 4) return Number.MAX_SAFE_INTEGER;
    const cx = (rect[0] + rect[2]) / 2;
    const cy = (rect[1] + rect[3]) / 2; // PDF y grows upward, so a larger y is higher on the page
    const col = twoColumn && cx >= midX ? 1 : 0;
    return col * 1e7 - cy;
}

/**
 * Main entry point: the references cited on `pageNumber` (1-based), de-duplicated
 * and ordered by where their citation first appears on the page (reading order).
 * `pageCache` (optional) memoizes per-page text models across calls so repeated
 * page changes stay cheap.
 */
export async function getCitedReferencesOnPage(
    pdf: PdfLike,
    pageNumber: number,
    pageCache?: Map<number, PageModel>
): Promise<PageReference[]> {
    const page = await pdf.getPage(pageNumber);
    const annotations = await page.getAnnotations();
    const internalLinks = annotations.filter(a => a.subtype === 'Link' && a.dest != null && !a.url);

    // Model of the current page, used to rank citations into reading order
    // (column + vertical position). Cached like the destination pages.
    const curIndex = pageNumber - 1;
    let curModel = pageCache?.get(curIndex);
    if (!curModel) {
        const tc = await page.getTextContent();
        curModel = buildPageModel(tc.items, pageWidthOf(page, tc.items));
        pageCache?.set(curIndex, curModel);
    }

    // Resolve every citation link to a destination page + position, keeping its
    // on-page reading order so the panel can list references as they're cited.
    interface Cite {
        target: ResolvedTarget;
        order: number;
    }
    const cites: Cite[] = [];
    for (const link of internalLinks) {
        const target = await resolveDestination(pdf, link.dest as string | unknown[]);
        if (!target) continue;
        cites.push({ target, order: citationOrder(link.rect, curModel.twoColumn, curModel.midX) });
    }

    const results = new Map<string, { ref: PageReference; order: number }>();
    for (const { target, order } of cites) {
        const pageIndex = target.pageIndex;
        let model = pageCache?.get(pageIndex);
        if (!model) {
            const destPage = await pdf.getPage(pageIndex + 1);
            const tc = await destPage.getTextContent();
            model = buildPageModel(tc.items, pageWidthOf(destPage, tc.items));
            pageCache?.set(pageIndex, model);
        }
        if (model.markers.length === 0) continue; // destination is not a bibliography (e.g. figure/section/ToC link)
        const markerIdx = findEntryAt(model, target);
        if (markerIdx < 0) continue;
        const marker = model.markers[markerIdx];
        // Numbered references de-dup by their global [N]; author–year ones by
        // the entry they land on (same destination → same page + line).
        const id = marker.number != null ? `n:${marker.number}` : `p:${pageIndex}:${marker.lineIndex}`;
        const existing = results.get(id);
        if (existing) {
            existing.order = Math.min(existing.order, order); // rank by first appearance
            continue;
        }
        const fullText = extractEntryText(model, markerIdx);
        results.set(id, {
            order,
            ref: {
                id,
                number: marker.number,
                label: marker.number != null ? String(marker.number) : authorYearLabel(fullText),
                title: guessTitle(fullText),
                fullText,
                destPage: pageIndex + 1
            }
        });
    }

    return [...results.values()].sort((a, b) => a.order - b.order).map(e => e.ref);
}
