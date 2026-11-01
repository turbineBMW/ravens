/**
 * The app's own API, relative to its base path (`/huginn`, `/muninn`): the
 * server answers under the base, so the same code works behind
 * `tailscale serve` and the Vite dev proxy.
 */
import type { HealthResponse, Identity } from './types';

export * from './types';

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

export function createApi(base: string) {
    async function request<T>(path: string, init?: RequestInit): Promise<T> {
        const res = await fetch(`${base}/v1${path}`, {
            ...init,
            headers: {
                accept: 'application/json',
                ...(init?.body ? { 'content-type': 'application/json' } : {}),
                ...init?.headers,
            },
        });
        if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText);
        return (await res.json()) as T;
    }
    return {
        request,
        health: () => request<HealthResponse>('/health'),
        me: () => request<Identity>('/me'),
    };
}

export type Api = ReturnType<typeof createApi>;
