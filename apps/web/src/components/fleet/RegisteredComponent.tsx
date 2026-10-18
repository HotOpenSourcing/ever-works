'use client';

import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';

/** One lazily-loaded component per registration id (React.lazy must be created once). */
const cache = new Map<string, ComponentType<object>>();

/** Keeps one failing registered component from taking the page down (spec §6 Reliability). */
class RegisteredBoundary extends Component<
    { fallback: ReactNode; children: ReactNode },
    { failed: boolean }
> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    render() {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
}

/**
 * Fleet hub (FL-01, README D9) — render a component another epic registered
 * (an Overview block, a computer action): code-split (its bundle loads only
 * when it renders), with `loading` shown while it loads and `failed` shown in
 * its place if it throws — never taking the surrounding page with it.
 */
export function RegisteredComponent<P extends object>({
    id,
    load,
    props,
    loading,
    failed,
}: {
    id: string;
    load: () => Promise<{ default: ComponentType<P> }>;
    props: P;
    loading: ReactNode;
    failed: ReactNode;
}) {
    let Loaded = cache.get(id) as ComponentType<P> | undefined;
    if (!Loaded) {
        Loaded = lazy(load);
        cache.set(id, Loaded as ComponentType<object>);
    }
    return (
        <RegisteredBoundary fallback={failed}>
            <Suspense fallback={loading}>
                {/* Created once per registration id and cached at module level above,
                    never per render — so its state survives re-renders. */}
                {/* eslint-disable-next-line react-hooks/static-components */}
                <Loaded {...props} />
            </Suspense>
        </RegisteredBoundary>
    );
}
