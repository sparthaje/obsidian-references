/*
 * The "References on this page" side panel. A plain ItemView (no React) that
 * subscribes to the ReferencesController and renders the list of references
 * cited on the page currently shown in the active PDF.
 */
import { ItemView, WorkspaceLeaf } from 'obsidian';
import type AnnotatorPlugin from 'main';
import { VIEW_TYPE_REFERENCES, REFERENCES_ICON } from 'constants';
import type { ReferencesState } from 'references/referencesController';

export const REFERENCES_STYLES = `
.links-references-panel { padding: 0; }
.links-references-header { position: sticky; top: 0; background: var(--background-secondary); padding: 8px 12px;
    border-bottom: 1px solid var(--background-modifier-border); display: flex; flex-direction: column; gap: 2px; z-index: 1; }
.links-references-title { font-weight: 600; font-size: var(--font-ui-small); }
.links-references-subtitle { font-size: var(--font-ui-smaller); color: var(--text-muted); }
.links-references-list { padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
.links-reference-row { display: flex; gap: 8px; padding: 8px; border-radius: var(--radius-s); cursor: pointer; align-items: baseline; }
.links-reference-row:hover { background: var(--background-modifier-hover); }
.links-reference-num { color: var(--text-accent); font-weight: 600; font-variant-numeric: tabular-nums; flex-shrink: 0; }
.links-reference-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.links-reference-title { font-size: var(--font-ui-small); line-height: 1.3; }
.links-reference-full { font-size: var(--font-ui-smaller); color: var(--text-muted); line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.links-references-empty { padding: 16px 12px; color: var(--text-muted); font-size: var(--font-ui-smaller); line-height: 1.5; }
`;

export default class ReferencesPanelView extends ItemView {
    plugin: AnnotatorPlugin;
    private unsubscribe: (() => void) | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: AnnotatorPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return VIEW_TYPE_REFERENCES;
    }
    getDisplayText(): string {
        return 'References on page';
    }
    getIcon(): string {
        return REFERENCES_ICON;
    }

    async onOpen() {
        this.contentEl.addClass('links-references-panel');
        const controller = this.plugin.referencesController;
        if (!controller) {
            this.render(null);
            return;
        }
        // subscribe() immediately invokes the callback with the current state.
        this.unsubscribe = controller.subscribe(state => this.render(state));
    }

    async onClose() {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    private render(state: ReferencesState | null) {
        const el = this.contentEl;
        el.empty();

        if (!state) {
            el.createDiv({
                cls: 'links-references-empty',
                text: 'Open a PDF (a note with an "annotation-target") to see the references cited on the page you are viewing.'
            });
            return;
        }

        const header = el.createDiv({ cls: 'links-references-header' });
        header.createSpan({ cls: 'links-references-title', text: 'References on this page' });
        header.createSpan({
            cls: 'links-references-subtitle',
            text: state.numPages ? `Page ${state.page} of ${state.numPages}` : `Page ${state.page}`
        });

        if (state.error) {
            el.createDiv({ cls: 'links-references-empty', text: `Could not read references: ${state.error}` });
            return;
        }

        const list = el.createDiv({ cls: 'links-references-list' });

        if (state.refs.length === 0) {
            list.createDiv({
                cls: 'links-references-empty',
                text: state.loading ? 'Reading references…' : 'No linked references found on this page.'
            });
            return;
        }

        for (const ref of state.refs) {
            const row = list.createDiv({ cls: 'links-reference-row' });
            row.setAttribute('role', 'button');
            row.setAttribute('title', `Jump to reference [${ref.number}] on page ${ref.destPage}`);
            row.createSpan({ cls: 'links-reference-num', text: `[${ref.number}]` });
            const body = row.createDiv({ cls: 'links-reference-body' });
            body.createDiv({ cls: 'links-reference-title', text: ref.title });
            if (ref.fullText && ref.fullText !== ref.title) {
                body.createDiv({ cls: 'links-reference-full', text: ref.fullText });
            }
            row.addEventListener('click', () => this.plugin.referencesController.jumpToPage(ref.destPage));
        }
    }
}
