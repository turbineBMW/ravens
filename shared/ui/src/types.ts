/** Mirrors shared/raven-core/src/lib.rs. Keep the two in step by hand until a generator earns its place. */

export type RavenApp = 'huginn' | 'muninn';

export interface Identity {
    login: string;
    name?: string;
}

export interface LinkTarget {
    app: RavenApp;
    id: string;
    fragment?: string;
}

export interface HealthResponse {
    app: RavenApp;
    version: string;
    schema: number;
}

/** The deep link that opens a target in its app; mirrors LinkTarget::href. */
export function linkHref(link: LinkTarget): string {
    const kind = link.app === 'huginn' ? 'n' : 't';
    return `/${link.app}/${kind}/${link.id}${link.fragment ? `#${link.fragment}` : ''}`;
}
