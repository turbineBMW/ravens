// Closes a <details> menu on a press outside it or on Escape, like a popover.
export function dismiss(menu: HTMLDetailsElement) {
    const onPress = (event: PointerEvent) => {
        if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
        if (menu.open && event.key === 'Escape') {
            menu.open = false;
            menu.querySelector('summary')?.focus();
        }
    };
    document.addEventListener('pointerdown', onPress);
    document.addEventListener('keydown', onKey);
    return {
        destroy() {
            document.removeEventListener('pointerdown', onPress);
            document.removeEventListener('keydown', onKey);
        },
    };
}
