/**
 * Adapted from HBAI-Ltd/Toonflow-app@30139c931e80476caa718b31684b86383c6e83ce
 * apps/web/src/pages/workspace/panels/canvas/arrangeSelection.ts (MIT)
 * Copyright (c) 2026 HBAI-Ltd — see ../NOTICE
 *
 * Vue Flow → plain geometry for ToIV canvas nodes (no Vue dependency).
 */
export type ArrangeSelectionMode = "horizontal" | "vertical" | "grid";

export type ArrangeNodeBox = {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** When nested, parent absolute offset already baked into x/y by caller. */
};

export type ArrangePosition = { id: string; x: number; y: number };

const GAP = 80;

/**
 * Arrange selected node boxes into a row / column / grid, preserving origin
 * of the selection bounding box. Returns new absolute positions.
 */
export function arrangeSelectionBoxes(nodes: ArrangeNodeBox[], mode: ArrangeSelectionMode): ArrangePosition[] {
    if (nodes.length < 2) return nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
    const items = [...nodes];
    items.sort((a, b) =>
        mode === "horizontal"
            ? a.x - b.x || a.y - b.y
            : a.y - b.y || a.x - b.x,
    );
    const origin = {
        x: Math.min(...items.map((item) => item.x)),
        y: Math.min(...items.map((item) => item.y)),
    };
    const columns = mode === "horizontal" ? items.length : mode === "vertical" ? 1 : Math.ceil(Math.sqrt(items.length));
    const columnWidths = Array<number>(columns).fill(0);
    const rowHeights = Array<number>(Math.ceil(items.length / columns)).fill(0);
    items.forEach((node, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        columnWidths[column] = Math.max(columnWidths[column]!, node.width);
        rowHeights[row] = Math.max(rowHeights[row]!, node.height);
    });
    let x = origin.x;
    const columnPositions = columnWidths.map((width) => {
        const position = x;
        x += width + GAP;
        return position;
    });
    let y = origin.y;
    const rowPositions = rowHeights.map((height) => {
        const position = y;
        y += height + GAP;
        return position;
    });
    return items.map((node, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        return {
            id: node.id,
            x: columnPositions[column]! + (mode === "vertical" ? (columnWidths[column]! - node.width) / 2 : 0),
            y: rowPositions[row]! + (mode === "horizontal" ? (rowHeights[row]! - node.height) / 2 : 0),
        };
    });
}
