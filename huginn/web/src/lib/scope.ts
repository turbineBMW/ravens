/**
 * What the notes list shows: every note, as a tree of folders, or Recently
 * Deleted (`?view=trash`). It lives in the query string, so `/n/<id>` links
 * stay the same and Back, Forward and reloads keep the list where it was.
 */
import { base } from '$app/paths';

export type Scope = { kind: 'all' } | { kind: 'trash' };

export function scopeOf(url: URL): Scope {
    return url.searchParams.get('view') === 'trash' ? { kind: 'trash' } : { kind: 'all' };
}

/** The query string that keeps a scope: '' or '?view=trash'. */
export function scopeQuery(scope: Scope): string {
    return scope.kind === 'trash' ? '?view=trash' : '';
}

/** The list in that scope. */
export function listHref(scope: Scope): string {
    return `${base}/${scopeQuery(scope)}`;
}

/** A note, with the list beside it kept in that scope. */
export function noteHref(id: string, scope: Scope, section?: string): string {
    return `${base}/n/${id}${scopeQuery(scope)}${section ? `#section-${section}` : ''}`;
}
