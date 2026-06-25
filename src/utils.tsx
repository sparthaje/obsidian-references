import AnnotatorPlugin from 'main';
import { requestUrl } from 'obsidian';

// This fetch can be used to get internal(like blob) and external resources with CORS policies
export async function fetchUrl(requestInfo: RequestInfo, requestInit?: RequestInit): Promise<Response> {
    // Use regular fetch for blobs, because obsidian.requestUrl can't access files by path
    if (requestInfo.toString().startsWith('blob:')) return await fetch(requestInfo, requestInit);

    const requestHeaders = new Headers(requestInit?.headers);
    const requestBody = ((): string | undefined => {
        if (!requestInit?.body) return undefined;

        if (typeof requestInit.body === 'string') {
            return requestInit.body;
        } else {
            AnnotatorPlugin.instance.log('Request Body nor string or null: ', requestInit.body);
            return undefined;
        }
    })();

    try {
        const response = await requestUrl({
            url: typeof requestInfo === 'string' ? requestInfo : requestInfo.url,
            method: requestInit?.method,
            body: requestBody,
            contentType: requestHeaders.get('Content-Type'),
            headers: Object.fromEntries(requestHeaders?.entries()),
            throw: false
        });

        return new Response(response.arrayBuffer, {
            status: response.status,
            statusText: 'ok',
            headers: new Headers(response.headers)
        });
    } catch (e) {
        return await fetch(requestInfo, requestInit);
    }
}

export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function get_url_extension(url) {
    return url.split(/[#?]/)[0].split('.').pop().trim();
}

// Determine whether an annotation target is a pdf/epub/etc. Falls back to the file
// extension, but also recognizes research-PDF URLs that lack a `.pdf` extension
// (e.g. https://arxiv.org/pdf/2104.14294 or https://openreview.net/pdf?id=...).
export function getAnnotationTargetType(target: string, explicitType?: string | null): string {
    if (explicitType) return explicitType;
    const ext = get_url_extension(target).toLowerCase();
    if (ext === 'pdf' || ext === 'epub') return ext;
    const t = target.toLowerCase();
    if (
        /arxiv\.org\/pdf\//.test(t) ||
        /openreview\.net\/pdf\b/.test(t) ||
        /\/pdf(\/|\?|#|$)/.test(t) ||
        /[?&](format|download|file)=[^&]*pdf\b/.test(t)
    ) {
        return 'pdf';
    }
    return ext;
}

export function isUrl(potentialUrl: string) {
    try {
        new URL(potentialUrl);
        return true;
    } catch (e) {
        return false;
    }
}

export function utf8_to_b64(str) {
    return window.btoa(unescape(encodeURIComponent(str)));
}

export function b64_to_utf8(str) {
    return decodeURIComponent(escape(window.atob(str)));
}

// Used to prevent spamming the callback function
// will only call the last callback after no calls have
// been made for ms milliseconds. The preceeding callbacks
// will be ignored.
export function callDelayer() {
    let timeoutId: NodeJS.Timeout;
    return (callback, ms) => {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        timeoutId = setTimeout(() => {
            timeoutId = null;
            callback();
        }, ms);
    };
}
