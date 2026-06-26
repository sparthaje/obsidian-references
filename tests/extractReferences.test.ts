import {
    buildPageModel,
    authorYearLabel,
    getCitedReferencesOnPage,
    extractEntryText
} from '../src/references/extractReferences';
import type { TextItemLike, PdfLike, PageLike, AnnotationLike } from '../src/references/extractReferences';

/** Build pdf.js-style text items from {x, y, str} lines (transform = [1,0,0,1,x,y]). */
function items(lines: { x: number; y: number; str: string }[]): TextItemLike[] {
    return lines.map(l => ({ str: l.str, transform: [1, 0, 0, 1, l.x, l.y], width: l.str.length * 5, height: 10 }));
}

const PAGE_WIDTH = 612;

// A fragment of the ViT bibliography (arXiv:2010.11929): an author–year layout
// with a hanging indent — entry first lines at x=108, continuations at x=118.
const authorYearLines = [
    { x: 108, y: 754, str: 'Published as a conference paper at ICLR 2021' }, // running header
    { x: 108, y: 698, str: 'Alexei Baevski and Michael Auli. Adaptive input representations for neural language modeling. In' },
    { x: 118, y: 687, str: 'ICLR, 2019.' },
    { x: 108, y: 667, str: 'I. Bello, B. Zoph, Q. Le, A. Vaswani, and J. Shlens. Attention augmented convolutional networks.' },
    { x: 118, y: 656, str: 'In ICCV, 2019.' },
    { x: 108, y: 605, str: 'Tom B Brown, Benjamin Mann, Nick Ryder, Melanie Subbiah, and Jared Kaplan. Language models' },
    { x: 118, y: 595, str: 'are few-shot learners. arXiv, 2020.' },
    {
        x: 108,
        y: 349,
        str: 'Jacob Devlin, Ming-Wei Chang, Kenton Lee, and Kristina Toutanova. BERT: Pre-training of deep'
    },
    { x: 118, y: 338, str: 'bidirectional transformers for language understanding. In NAACL, 2019.' }
];

// A numbered bibliography page.
const numberedLines = [
    { x: 50, y: 700, str: '[1] A. Author and B. Writer. Some foundational paper. In NeurIPS, 2017.' },
    { x: 64, y: 689, str: 'pages 1-10.' },
    { x: 50, y: 660, str: '[2] C. Coder. Another paper about things. arXiv:2001.00001, 2020.' }
];

// Ordinary two-column-free body text: almost every line flush-left, no hanging
// indent. A figure/section link landing here must NOT be read as a bibliography.
const bodyLines = Array.from({ length: 20 }, (_, i) => ({
    x: 108,
    y: 700 - i * 14,
    str: `This is a sentence of running body prose number ${i} that flows full width.`
}));

describe('authorYearLabel', () => {
    it('labels a multi-author entry with "et al." and the year', () => {
        expect(authorYearLabel('Ashish Vaswani, Noam Shazeer, et al. Attention is all you need. In NIPS, 2017.')).toBe(
            'Vaswani et al. 2017'
        );
    });

    it('labels a single-author entry without "et al."', () => {
        expect(authorYearLabel('Alex Krizhevsky. Learning multiple layers of features. Technical report, 2009.')).toBe(
            'Krizhevsky 2009'
        );
    });

    it('keeps the surname when the first author is given as an initial', () => {
        expect(authorYearLabel('I. Bello, B. Zoph, and J. Shlens. Attention augmented networks. In ICCV, 2019.')).toBe(
            'Bello et al. 2019'
        );
    });

    it('preserves a disambiguating year suffix (2020a)', () => {
        expect(authorYearLabel('Mark Chen and Alec Radford. Generative pretraining from pixels. In ICML, 2020a.')).toBe(
            'Chen et al. 2020a'
        );
    });
});

// A synthetic two-column body page: two words per line in each column, an empty
// central gutter (nothing straddles the midline at x=306).
function twoColumnItems(): TextItemLike[] {
    const lines: { x: number; y: number; str: string }[] = [];
    for (let i = 0; i < 14; i++) {
        const y = 740 - i * 22;
        lines.push({ x: 60, y, str: 'left' }, { x: 130, y, str: 'column' }); // left column (ends well before 306)
        lines.push({ x: 320, y, str: 'right' }, { x: 400, y, str: 'column' }); // right column (starts after 306)
    }
    return items(lines);
}

describe('buildPageModel column detection', () => {
    it('detects a two-column page by its empty central gutter', () => {
        expect(buildPageModel(twoColumnItems(), PAGE_WIDTH).twoColumn).toBe(true);
    });

    it('treats full-width prose (lines straddling the midline) as single column', () => {
        expect(buildPageModel(items(bodyLines), PAGE_WIDTH).twoColumn).toBe(false);
    });
});

describe('buildPageModel marker detection', () => {
    it('detects numbered [N] entries', () => {
        const model = buildPageModel(items(numberedLines), PAGE_WIDTH);
        expect(model.markers.map(m => m.number)).toEqual([1, 2]);
    });

    it('detects author–year entries by hanging indent', () => {
        const model = buildPageModel(items(authorYearLines), PAGE_WIDTH);
        // Four entry starts (header + the four references all sit flush left).
        const starts = model.markers.map(m => m.lineIndex);
        expect(model.markers.every(m => m.number === null)).toBe(true);
        // The first real entry's text is reconstructed from its flush + indented lines.
        const baevski = model.markers.findIndex(
            m => model.orderedLines[m.lineIndex].text.startsWith('Alexei Baevski')
        );
        expect(baevski).toBeGreaterThanOrEqual(0);
        expect(extractEntryText(model, baevski)).toContain('In ICLR, 2019.');
        expect(starts.length).toBeGreaterThanOrEqual(4);
    });

    it('does not treat flush-left body prose as a bibliography', () => {
        const model = buildPageModel(items(bodyLines), PAGE_WIDTH);
        expect(model.markers).toHaveLength(0);
    });
});

/** A minimal in-memory PdfLike: page 1 cites two works; page 2 is the bibliography. */
function fakePdf(): PdfLike {
    // Devlin is cited higher on the page (y≈700) than Baevski (y≈500), so reading
    // order is [Devlin, Baevski] — the reverse of alphabetical, which the panel
    // used to produce. rect = [x0, y0, x1, y1] in PDF coords (y grows upward).
    const citingAnnotations: AnnotationLike[] = [
        { subtype: 'Link', dest: 'cite.baevski', rect: [100, 500, 140, 510] },
        { subtype: 'Link', dest: 'cite.baevski', rect: [200, 480, 240, 490] }, // duplicate citation on the page
        { subtype: 'Link', dest: 'cite.devlin', rect: [100, 700, 140, 710] }
    ];
    const dests: Record<string, unknown[]> = {
        'cite.baevski': [{ ref: 'bib' }, { name: 'XYZ' }, 83, 700, 0],
        'cite.devlin': [{ ref: 'bib' }, { name: 'XYZ' }, 83, 352, 0]
    };
    const page1: PageLike = {
        getAnnotations: async () => citingAnnotations,
        getTextContent: async () => ({ items: [] }),
        view: [0, 0, PAGE_WIDTH, 792]
    };
    const bibPage: PageLike = {
        getAnnotations: async () => [],
        getTextContent: async () => ({ items: items(authorYearLines) }),
        view: [0, 0, PAGE_WIDTH, 792]
    };
    return {
        getPage: async (n: number) => (n === 1 ? page1 : bibPage),
        getDestination: async (id: string) => dests[id] ?? null,
        getPageIndex: async () => 1 // bibliography is page index 1 (page 2)
    };
}

describe('getCitedReferencesOnPage (author–year, end to end)', () => {
    it('resolves citation links to author–year entries, ordered by appearance and de-duplicated', async () => {
        const refs = await getCitedReferencesOnPage(fakePdf(), 1);
        // Devlin is cited above Baevski, so it comes first (reading order, not alphabetical).
        expect(refs.map(r => r.label)).toEqual(['Devlin et al. 2019', 'Baevski et al. 2019']);
        expect(refs.every(r => r.number === null)).toBe(true);
        expect(refs[0].destPage).toBe(2);
        expect(refs.find(r => r.label.startsWith('Devlin'))?.fullText).toContain('BERT');
    });
});

/** A two-column reading page: the bibliography (page 2) is the same author–year list. */
function fakeTwoColumnPdf(): PdfLike {
    // brown sits highest in the right column; devlin is lower in the left column.
    // Correct reading order is left-column-then-right: [baevski, devlin, brown],
    // even though brown is physically higher on the page than devlin.
    const citingAnnotations: AnnotationLike[] = [
        { subtype: 'Link', dest: 'cite.baevski', rect: [60, 700, 100, 710] }, // left col, top
        { subtype: 'Link', dest: 'cite.devlin', rect: [60, 400, 100, 410] }, // left col, lower
        { subtype: 'Link', dest: 'cite.brown', rect: [320, 730, 360, 740] } // right col, highest
    ];
    const dests: Record<string, unknown[]> = {
        'cite.baevski': [{ ref: 'bib' }, { name: 'XYZ' }, 83, 700, 0],
        'cite.brown': [{ ref: 'bib' }, { name: 'XYZ' }, 83, 607, 0],
        'cite.devlin': [{ ref: 'bib' }, { name: 'XYZ' }, 83, 352, 0]
    };
    const page1: PageLike = {
        getAnnotations: async () => citingAnnotations,
        getTextContent: async () => ({ items: twoColumnItems() }),
        view: [0, 0, PAGE_WIDTH, 792]
    };
    const bibPage: PageLike = {
        getAnnotations: async () => [],
        getTextContent: async () => ({ items: items(authorYearLines) }),
        view: [0, 0, PAGE_WIDTH, 792]
    };
    return {
        getPage: async (n: number) => (n === 1 ? page1 : bibPage),
        getDestination: async (id: string) => dests[id] ?? null,
        getPageIndex: async () => 1
    };
}

describe('getCitedReferencesOnPage (two-column reading order)', () => {
    it('orders the whole left column before the right column, top-to-bottom within each', async () => {
        const refs = await getCitedReferencesOnPage(fakeTwoColumnPdf(), 1);
        expect(refs.map(r => r.label)).toEqual([
            'Baevski et al. 2019', // left column, top
            'Devlin et al. 2019', // left column, lower
            'Brown et al. 2020' // right column (highest on page, but read last)
        ]);
    });
});
