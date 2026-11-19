export function insertSorted(items, item, precedes) {
    const last = items.at(-1);
    if (last === undefined || !precedes(item, last)) {
        items.push(item);
        return;
    }
    const first = items[0];
    if (first !== undefined && precedes(item, first)) {
        items.unshift(item);
        return;
    }
    let low = 1;
    let high = items.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const current = items[middle];
        if (current !== undefined && precedes(item, current)) {
            high = middle;
        }
        else {
            low = middle + 1;
        }
    }
    items.splice(low, 0, item);
}
