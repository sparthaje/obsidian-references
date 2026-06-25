/*
 * Best-effort extraction of a paper's title from its PDF, used to retitle an
 * annotation note when its annotation-target is set (see Part 2 of the Links
 * feature). Two signals, tried in order:
 *   1. the PDF's embedded /Title metadata, when it looks like a real title;
 *   2. otherwise the largest-font text block near the top of page 1.
 * Entirely local — no network lookups — mirroring the references extractor.
 */
import { cleanText } from 'references/extractReferences';
import type { PdfLike, PageLike, TextItemLike } from 'references/extractReferences';

// pdf.js' PDFDocumentProxy.getMetadata(); not part of the structural PdfLike.
interface PdfMetaLike {
    getMetadata?(): Promise<{ info?: { Title?: string } }>;
}

const MIN_TITLE_LEN = 5;
const MAX_TITLE_LEN = 300;

function cleanTitle(raw: string): string {
    return cleanText(raw)
        .replace(/^microsoft word\s*-\s*/i, '') // common authoring-tool junk
        .replace(/[.,;]+$/, '')
        .trim();
}

function isPlausibleTitle(title: string): boolean {
    if (title.length < MIN_TITLE_LEN || title.length > MAX_TITLE_LEN) return false;
    if (title.split(/\s+/).filter(Boolean).length < 2) return false;
    if (/^untitled\b/i.test(title)) return false;
    if (/\.(pdf|docx?|tex|dvi)$/i.test(title)) return false; // a filename, not a title
    if (/\//.test(title)) return false; // a path
    return true;
}

async function titleFromMetadata(pdf: PdfLike): Promise<string | null> {
    try {
        const md = await (pdf as unknown as PdfMetaLike).getMetadata?.();
        const raw = md?.info?.Title;
        if (!raw || typeof raw !== 'string') return null;
        const title = cleanTitle(raw);
        return isPlausibleTitle(title) ? title : null;
    } catch {
        return null;
    }
}

const fontSizeOf = (it: TextItemLike): number => {
    const t = it.transform;
    const scaled = t && t.length >= 4 ? Math.hypot(t[2], t[3]) : 0;
    return scaled || it.height || 0;
};

async function titleFromFirstPage(pdf: PdfLike): Promise<string | null> {
    let page: PageLike;
    try {
        page = await pdf.getPage(1);
    } catch {
        return null;
    }
    const content = await page.getTextContent();
    const items = content.items.filter(it => it.str && it.str.trim());
    if (items.length === 0) return null;

    const y0 = page.view && page.view.length >= 4 ? page.view[1] : 0;
    const pageHeight = page.view && page.view.length >= 4 ? page.view[3] - page.view[1] : 792;

    // Titles sit near the top; restrict to the top ~60% to avoid large body text
    // or footers winning the "largest font" contest.
    const topItems = items.filter(it => {
        const y = it.transform?.[5] ?? 0;
        return y - y0 > pageHeight * 0.4;
    });
    const pool = topItems.length ? topItems : items;

    const maxSize = Math.max(...pool.map(fontSizeOf));
    if (!(maxSize > 0)) return null;

    const big = pool.filter(it => fontSizeOf(it) >= maxSize - 0.5);
    // Reading order: top-to-bottom (PDF y grows upward), then left-to-right.
    big.sort((a, b) => {
        const ay = a.transform?.[5] ?? 0;
        const by = b.transform?.[5] ?? 0;
        if (Math.abs(ay - by) > 2) return by - ay;
        return (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0);
    });

    const title = cleanTitle(big.map(it => it.str).join(' '));
    return isPlausibleTitle(title) ? title : null;
}

export async function extractPdfTitle(pdf: PdfLike): Promise<string | null> {
    return (await titleFromMetadata(pdf)) ?? (await titleFromFirstPage(pdf));
}
