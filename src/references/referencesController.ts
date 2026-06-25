/*
 * Bridges the active PDF viewer (pdf.js, running inside the annotator iframe)
 * and the References side panel. It tracks which page the reader is on, runs
 * the reference extraction for that page, and notifies subscribers (the panel).
 */
import type AnnotatorPlugin from 'main';
import { getCitedReferencesOnPage } from 'references/extractReferences';
import type { PageReference, PdfLike } from 'references/extractReferences';

interface EventBusLike {
    on(name: string, cb: (e: { pageNumber?: number }) => void): void;
    off(name: string, cb: (e: { pageNumber?: number }) => void): void;
}

// The slice of pdf.js' PDFViewerApplication we rely on.
export interface PdfViewerApplicationLike {
    pdfDocument: (PdfLike & { numPages: number }) | null;
    eventBus?: EventBusLike;
    page: number; // current page (1-based); settable to scroll the viewer
}

export interface ReferencesState {
    refs: PageReference[];
    page: number;
    numPages: number;
    pdfSrc: string;
    annotationFile: string;
    loading: boolean;
    error?: string;
}

type Subscriber = (state: ReferencesState | null) => void;

interface ActiveViewer {
    pvApp: PdfViewerApplicationLike;
    pdfSrc: string;
    annotationFile: string;
    pageCache: Map<number, unknown>;
    cleanup: () => void;
}

export default class ReferencesController {
    private plugin: AnnotatorPlugin;
    private viewers = new Map<string, { pvApp: PdfViewerApplicationLike; pdfSrc: string; annotationFile: string }>();
    private active: ActiveViewer | null = null;
    private state: ReferencesState | null = null;
    private subscribers = new Set<Subscriber>();
    private updateSeq = 0;
    private debounceTimer: number | null = null;

    constructor(plugin: AnnotatorPlugin) {
        this.plugin = plugin;
    }

    subscribe(cb: Subscriber): () => void {
        this.subscribers.add(cb);
        cb(this.state);
        return () => this.subscribers.delete(cb);
    }

    private emit() {
        for (const cb of this.subscribers) cb(this.state);
    }

    getState(): ReferencesState | null {
        return this.state;
    }

    /** Called from definePdfAnnotation once a PDF view's pdf.js viewer is ready. */
    registerViewer(pvApp: PdfViewerApplicationLike, pdfSrc: string, annotationFile: string) {
        this.viewers.set(annotationFile, { pvApp, pdfSrc, annotationFile });
        this.attach(pvApp, pdfSrc, annotationFile);
        void this.plugin.activateReferencesPanel(false);
    }

    /** Called when a PDF view is unloaded/closed. */
    unregisterViewer(annotationFile: string) {
        this.viewers.delete(annotationFile);
        if (this.active?.annotationFile === annotationFile) {
            this.detach();
            this.state = null;
            this.emit();
        }
    }

    /** Called on active-leaf-change when the newly active leaf is a known PDF view. */
    onActiveViewer(annotationFile: string) {
        const v = this.viewers.get(annotationFile);
        if (v && v.pvApp !== this.active?.pvApp) {
            this.attach(v.pvApp, v.pdfSrc, v.annotationFile);
        }
    }

    /**
     * Open (creating if needed) the reference note for a citation and link it
     * from the paper currently being read. Used by the panel's "open backlink"
     * button.
     */
    openReferenceNote(ref: PageReference) {
        const citingNotePath = this.state?.annotationFile ?? this.active?.annotationFile ?? null;
        void this.plugin.referenceNotesService.openReferenceNote(ref, citingNotePath);
    }

    /** Scroll the active PDF viewer to a page (used when a reference row is clicked). */
    jumpToPage(page: number) {
        if (!this.active?.pvApp) return;
        try {
            this.active.pvApp.page = page;
        } catch (e) {
            this.plugin.log('Links: failed to jump to page', e);
        }
    }

    private attach(pvApp: PdfViewerApplicationLike, pdfSrc: string, annotationFile: string) {
        this.detach();
        const pageCache = new Map<number, unknown>();
        const onPageChange = (e: { pageNumber?: number }) => this.scheduleUpdate(e?.pageNumber ?? pvApp.page ?? 1);

        let bound = false;
        let cancelled = false;
        let retitled = false;
        const init = () => {
            if (cancelled) return;
            if (pvApp.pdfDocument) {
                // Bind live page tracking when the event bus exists; either way render
                // the initial page's references as soon as the document is parsed.
                if (pvApp.eventBus && !bound) {
                    bound = true;
                    pvApp.eventBus.on('pagechanging', onPageChange);
                }
                // Retitle the backing note from the PDF's title, once per load.
                if (!retitled) {
                    retitled = true;
                    void this.plugin.referenceNotesService.retitleFromPdf(annotationFile, pvApp.pdfDocument);
                }
                this.scheduleUpdate(pvApp.page || 1);
            } else {
                window.setTimeout(init, 150); // document not parsed yet
            }
        };

        // Set active first so init()/events aren't treated as stale.
        this.active = {
            pvApp,
            pdfSrc,
            annotationFile,
            pageCache,
            cleanup: () => {
                cancelled = true;
                try {
                    pvApp.eventBus?.off?.('pagechanging', onPageChange);
                    pvApp.eventBus?.off?.('documentloaded', init);
                    pvApp.eventBus?.off?.('pagesloaded', init);
                } catch (e) {
                    /* viewer already torn down */
                }
            }
        };

        pvApp.eventBus?.on?.('documentloaded', init);
        pvApp.eventBus?.on?.('pagesloaded', init);
        init();
    }

    private detach() {
        if (this.debounceTimer != null) {
            window.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.active) {
            this.active.cleanup();
            this.active = null;
        }
    }

    private scheduleUpdate(page: number) {
        if (this.debounceTimer != null) window.clearTimeout(this.debounceTimer);
        this.debounceTimer = window.setTimeout(() => {
            this.debounceTimer = null;
            void this.update(page);
        }, 150);
    }

    private async update(page: number) {
        if (!this.active) return;
        const { pvApp, pdfSrc, annotationFile, pageCache } = this.active;
        const pdfDocument = pvApp.pdfDocument;
        if (!pdfDocument) return;
        const numPages = pdfDocument.numPages ?? 0;
        const seq = ++this.updateSeq;

        // Optimistic loading state (keep the previous list visible underneath).
        this.state = { refs: this.state?.refs ?? [], page, numPages, pdfSrc, annotationFile, loading: true };
        this.emit();

        try {
            const refs = await getCitedReferencesOnPage(pdfDocument, page, pageCache as Map<number, never>);
            if (seq !== this.updateSeq || this.active?.pvApp !== pvApp) return; // superseded by a newer update
            this.state = { refs, page, numPages, pdfSrc, annotationFile, loading: false };
            this.emit();
        } catch (e) {
            if (seq !== this.updateSeq) return;
            this.plugin.log('Links: reference extraction failed', e);
            this.state = { refs: [], page, numPages, pdfSrc, annotationFile, loading: false, error: String(e) };
            this.emit();
        }
    }

    dispose() {
        this.detach();
        this.viewers.clear();
        this.subscribers.clear();
        this.state = null;
    }
}
