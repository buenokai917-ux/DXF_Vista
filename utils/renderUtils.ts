import { DxfData, DxfEntity, EntityType, LayerColors, Bounds, SearchResult } from '../types';

interface RenderOptions {
    ctx: CanvasRenderingContext2D;
    data: DxfData;
    activeLayers: Set<string>;
    layerColors: LayerColors;
    filledLayers?: Set<string>;
    transform: { k: number, x: number, y: number };
    width: number;
    height: number;
    isPdfExport?: boolean;
    highlights?: SearchResult[];
    activeHighlightIndex?: number;
}

// ACI (AutoCAD Color Index) palette - model space defaults (AutoCAD 2020).
// Source: https://gohtx.com/acadcolors.php (matches ezdxf DXF_DEFAULT_COLORS).
const ACI_TABLE = [
    0x000000, 0xFF0000, 0xFFFF00, 0x00FF00, 0x00FFFF, 0x0000FF, 0xFF00FF, 0xFFFFFF, 0x808080, 0xC0C0C0,
    0xFF0000, 0xFF7F7F, 0xA50000, 0xA55252, 0x7F0000, 0x7F3F3F, 0x4C0000, 0x4C2626, 0x260000, 0x261313,
    0xFF3F00, 0xFF9F7F, 0xA52900, 0xA56752, 0x7F1F00, 0x7F4F3F, 0x4C1300, 0x4C2F26, 0x260900, 0x261713,
    0xFF7F00, 0xFFBF7F, 0xA55200, 0xA57C52, 0x7F3F00, 0x7F5F3F, 0x4C2600, 0x4C3926, 0x261300, 0x261C13,
    0xFFBF00, 0xFFDF7F, 0xA57C00, 0xA59152, 0x7F5F00, 0x7F6F3F, 0x4C3900, 0x4C4226, 0x261C00, 0x262113,
    0xFFFF00, 0xFFFF7F, 0xA5A500, 0xA5A552, 0x7F7F00, 0x7F7F3F, 0x4C4C00, 0x4C4C26, 0x262600, 0x262613,
    0xBFFF00, 0xDFFF7F, 0x7CA500, 0x91A552, 0x5F7F00, 0x6F7F3F, 0x394C00, 0x424C26, 0x1C2600, 0x212613,
    0x7FFF00, 0xBFFF7F, 0x52A500, 0x7CA552, 0x3F7F00, 0x5F7F3F, 0x264C00, 0x394C26, 0x132600, 0x1C2613,
    0x3FFF00, 0x9FFF7F, 0x29A500, 0x67A552, 0x1F7F00, 0x4F7F3F, 0x134C00, 0x2F4C26, 0x092600, 0x172613,
    0x00FF00, 0x7FFF7F, 0x00A500, 0x52A552, 0x007F00, 0x3F7F3F, 0x004C00, 0x264C26, 0x002600, 0x132613,
    0x00FF3F, 0x7FFF9F, 0x00A529, 0x52A567, 0x007F1F, 0x3F7F4F, 0x004C13, 0x264C2F, 0x002609, 0x132617,
    0x00FF7F, 0x7FFFBF, 0x00A552, 0x52A57C, 0x007F3F, 0x3F7F5F, 0x004C26, 0x264C39, 0x002613, 0x13261C,
    0x00FFBF, 0x7FFFDF, 0x00A57C, 0x52A591, 0x007F5F, 0x3F7F6F, 0x004C39, 0x264C42, 0x00261C, 0x132621,
    0x00FFFF, 0x7FFFFF, 0x00A5A5, 0x52A5A5, 0x007F7F, 0x3F7F7F, 0x004C4C, 0x264C4C, 0x002626, 0x132626,
    0x00BFFF, 0x7FDFFF, 0x007CA5, 0x5291A5, 0x005F7F, 0x3F6F7F, 0x00394C, 0x26424C, 0x001C26, 0x132126,
    0x007FFF, 0x7FBFFF, 0x0052A5, 0x527CA5, 0x003F7F, 0x3F5F7F, 0x00264C, 0x26394C, 0x001326, 0x131C26,
    0x003FFF, 0x7F9FFF, 0x0029A5, 0x5267A5, 0x001F7F, 0x3F4F7F, 0x00134C, 0x262F4C, 0x000926, 0x131726,
    0x0000FF, 0x7F7FFF, 0x0000A5, 0x5252A5, 0x00007F, 0x3F3F7F, 0x00004C, 0x26264C, 0x000026, 0x131326,
    0x3F00FF, 0x9F7FFF, 0x2900A5, 0x6752A5, 0x1F007F, 0x4F3F7F, 0x13004C, 0x2F264C, 0x090026, 0x171326,
    0x7F00FF, 0xBF7FFF, 0x5200A5, 0x7C52A5, 0x3F007F, 0x5F3F7F, 0x26004C, 0x39264C, 0x130026, 0x1C1326,
    0xBF00FF, 0xDF7FFF, 0x7C00A5, 0x9152A5, 0x5F007F, 0x6F3F7F, 0x39004C, 0x42264C, 0x1C0026, 0x211326,
    0xFF00FF, 0xFF7FFF, 0xA500A5, 0xA552A5, 0x7F007F, 0x7F3F7F, 0x4C004C, 0x4C264C, 0x260026, 0x261326,
    0xFF00BF, 0xFF7FDF, 0xA5007C, 0xA55291, 0x7F005F, 0x7F3F6F, 0x4C0039, 0x4C2642, 0x26001C, 0x261321,
    0xFF007F, 0xFF7FBF, 0xA50052, 0xA5527C, 0x7F003F, 0x7F3F5F, 0x4C0026, 0x4C2639, 0x260013, 0x26131C,
    0xFF003F, 0xFF7F9F, 0xA50029, 0xA55267, 0x7F001F, 0x7F3F4F, 0x4C0013, 0x4C262F, 0x260009, 0x261317,
    0x000000, 0x2D2D2D, 0x5B5B5B, 0x898989, 0xB7B7B7, 0xB3B3B3,
];

const ACI_HEX = ACI_TABLE.map(v => `#${v.toString(16).padStart(6, '0')}`);

// ACI (AutoCAD Color Index) mapping to hex. Handles BYBLOCK/BYLAYER codes via caller logic.
export const aciToHex = (aci: number): string => {
    if (Number.isNaN(aci)) return '#FFFFFF';
    const idx = Math.abs(Math.trunc(aci));
    if (idx >= 0 && idx < ACI_HEX.length) return ACI_HEX[idx].toUpperCase();
    return '#FFFFFF';
};

// Helper: Get Dash Array for standard linetypes
// Scaled by 1/k to ensure dashes remain visible on screen regardless of zoom (Paper Space feel)
const getLineDash = (lineType: string | undefined, scale: number): number[] => {
    if (!lineType) return [];

    const lt = lineType.toUpperCase();
    const s = 10 / scale; // Base dash unit scaled to screen pixels

    if (lt === 'CONTINUOUS') return [];
    if (lt.includes('DASHED')) return [s, s * 0.5];
    if (lt.includes('HIDDEN')) return [s * 0.5, s * 0.5];
    if (lt.includes('CENTER')) return [s * 1.5, s * 0.5, s * 0.2, s * 0.5];
    if (lt.includes('PHANTOM')) return [s * 1.5, s * 0.5, s * 0.2, s * 0.5, s * 0.2, s * 0.5];
    if (lt.includes('DOT')) return [s * 0.2, s * 0.2];
    if (lt.includes('DIVIDE')) return [s * 0.5, s * 0.2, s * 0.2, s * 0.2];
    if (lt.includes('BORDER')) return [s * 2, s * 0.5, s * 2, s * 0.5, s * 0.2, s * 0.5];

    // Default to continuous if unknown
    return [];
};

export const renderDxfToCanvas = ({
    ctx,
    data,
    activeLayers,
    layerColors,
    filledLayers,
    transform,
    width,
    height,
    isPdfExport = false,
    highlights,
    activeHighlightIndex
}: RenderOptions) => {
    // 1. Background Setup
    if (isPdfExport) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
    } else {
        ctx.fillStyle = '#0f172a'; // Slate 900
        ctx.fillRect(0, 0, width, height);
    }

    // 2. Prepare Transform Helper
    const applyTransform = (ctxToUse: CanvasRenderingContext2D) => {
        ctxToUse.translate(transform.x, height - transform.y);
        ctxToUse.scale(transform.k, -transform.k);
        ctxToUse.lineCap = 'round';
        ctxToUse.lineJoin = 'round';
    };

    const targetPixelWidth = isPdfExport ? 2 : 1;
    const baseLineWidth = targetPixelWidth / transform.k;

    // 4. Color Logic
    // Resolves logic: Entity Color > Layer Color
    // Handles 7 (White/Black) flip
    const resolveColor = (ent: DxfEntity, layerColor: string) => {
        let finalColor = layerColor;

        // Explicit Entity Color (Overrides Layer)
        if (ent.color !== undefined && ent.color !== 256 && ent.color !== 0) {
            finalColor = aciToHex(ent.color);
        }

        // Handle Color 7 Flip
        // If color is White (#FFFFFF) and background is White (PDF), flip to Black
        // If color is White (#FFFFFF) and background is Dark (Screen), keep White
        if (isPdfExport) {
            const c = finalColor.toLowerCase();
            if (c === '#ffffff' || c === '#fff') finalColor = '#000000';
            else if (c === '#ffff00') finalColor = '#eab308'; // Yellow hard to read on white
            else if (c === '#00ffff') finalColor = '#0891b2'; // Cyan hard to read on white
            else if (c === '#00ff00') finalColor = '#16a34a'; // Green hard to read on white
        }
        return finalColor;
    };

    // --- RENDER FUNCTIONS ---

    // A. Draw Stencils (Fills) - Draws OPAQUE shapes for composition
    const drawFillsRecursive = (currCtx: CanvasRenderingContext2D, entities: DxfEntity[], contextLayer: string) => {
        for (const ent of entities) {
            const effectiveLayer = ent.layer === '0' ? contextLayer : ent.layer;
            const isLayerActive = activeLayers.has(effectiveLayer);

            // Traverse Blocks even if layer is hidden (to find nested items)
            if (ent.type === EntityType.INSERT && ent.start && ent.blockName && data.blocks[ent.blockName]) {
                const basePoint = data.blockBasePoints[ent.blockName] || { x: 0, y: 0 };
                const rows = ent.rowCount || 1;
                const cols = ent.columnCount || 1;
                const rSpace = ent.rowSpacing || 0;
                const cSpace = ent.columnSpacing || 0;

                const drawBlock = (ox: number, oy: number) => {
                    currCtx.save();
                    currCtx.translate(ent.start!.x + ox, ent.start!.y + oy);
                    if (ent.rotation) currCtx.rotate(ent.rotation * Math.PI / 180);
                    currCtx.scale(ent.scale?.x || 1, ent.scale?.y || 1);
                    currCtx.translate(-basePoint.x, -basePoint.y);
                    drawFillsRecursive(currCtx, data.blocks[ent.blockName!], effectiveLayer);
                    currCtx.restore();
                };

                if (rows === 1 && cols === 1) {
                    drawBlock(0, 0);
                } else {
                    for (let r = 0; r < rows; r++) {
                        for (let c = 0; c < cols; c++) {
                            drawBlock(c * cSpace, r * rSpace);
                        }
                    }
                }
                continue;
            }

            // Handle Dimension Blocks (e.g. *D56) which contain arrows (filled solids)
            if (ent.type === EntityType.DIMENSION && ent.blockName && data.blocks[ent.blockName]) {
                // Dimensions in DXF usually have absolute coordinates in their anonymous blocks.
                // We render them without entity-level transforms, just passing the layer context.
                if (isLayerActive) {
                    drawFillsRecursive(currCtx, data.blocks[ent.blockName], effectiveLayer);
                }
                continue;
            }

            if (!isLayerActive) continue;

            // Only draw filled polygons if the layer is marked as FILLED
            if (filledLayers && filledLayers.has(effectiveLayer)) {
                const color = resolveColor(ent, layerColors[effectiveLayer] || '#e2e8f0');
                if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.closed) {
                    currCtx.fillStyle = color;
                    currCtx.beginPath();
                    currCtx.moveTo(ent.vertices[0].x, ent.vertices[0].y);
                    for (let i = 1; i < ent.vertices.length; i++) {
                        currCtx.lineTo(ent.vertices[i].x, ent.vertices[i].y);
                    }
                    currCtx.closePath();
                    currCtx.fill();
                } else if (ent.type === EntityType.CIRCLE && ent.center && ent.radius) {
                    currCtx.fillStyle = color;
                    currCtx.beginPath();
                    currCtx.arc(ent.center.x, ent.center.y, ent.radius, 0, 2 * Math.PI);
                    currCtx.fill();
                }
            }
        }
    };

    // B. Draw Strokes - Draws Lines, Arcs, Text, and Outlines of Polygons
    const drawStrokesRecursive = (currCtx: CanvasRenderingContext2D, entities: DxfEntity[], contextLayer: string, scaleAcc: number) => {
        for (const ent of entities) {
            const effectiveLayer = ent.layer === '0' ? contextLayer : ent.layer;
            const isLayerActive = activeLayers.has(effectiveLayer);

            // Allow strokes for all active layers (even filled ones) to ensure outlines (rectangles) are visible for beams/columns

            if (ent.type === EntityType.INSERT && ent.start && ent.blockName && data.blocks[ent.blockName]) {
                const basePoint = data.blockBasePoints[ent.blockName] || { x: 0, y: 0 };
                const rows = ent.rowCount || 1;
                const cols = ent.columnCount || 1;
                const rSpace = ent.rowSpacing || 0;
                const cSpace = ent.columnSpacing || 0;
                const scaleX = ent.scale?.x || 1;

                const drawBlock = (ox: number, oy: number) => {
                    currCtx.save();
                    currCtx.translate(ent.start!.x + ox, ent.start!.y + oy);
                    if (ent.rotation) currCtx.rotate(ent.rotation * Math.PI / 180);
                    currCtx.scale(ent.scale?.x || 1, ent.scale?.y || 1);
                    currCtx.translate(-basePoint.x, -basePoint.y);
                    drawStrokesRecursive(currCtx, data.blocks[ent.blockName!], effectiveLayer, scaleAcc * scaleX);
                    currCtx.restore();
                };

                if (rows === 1 && cols === 1) {
                    drawBlock(0, 0);
                } else {
                    for (let r = 0; r < rows; r++) {
                        for (let c = 0; c < cols; c++) {
                            drawBlock(c * cSpace, r * rSpace);
                        }
                    }
                }
                continue;
            }

            // Handle Dimension Blocks (e.g. *D56) containing lines, text, ticks
            if (ent.type === EntityType.DIMENSION && ent.blockName && data.blocks[ent.blockName]) {
                if (isLayerActive) {
                    // Render the anonymous block content directly (usually WCS)
                    drawStrokesRecursive(currCtx, data.blocks[ent.blockName], effectiveLayer, scaleAcc);
                }
                continue; // Skip manual fallback drawing
            }

            if (!isLayerActive) continue;

            const color = resolveColor(ent, layerColors[effectiveLayer] || '#e2e8f0');
            currCtx.strokeStyle = color;
            currCtx.fillStyle = color;
            currCtx.lineWidth = baseLineWidth / Math.abs(scaleAcc);

            currCtx.beginPath();

            if (ent.type === EntityType.LINE && ent.start && ent.end) {
                currCtx.moveTo(ent.start.x, ent.start.y);
                currCtx.lineTo(ent.end.x, ent.end.y);
                currCtx.stroke();
            }
            else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 0) {
                currCtx.moveTo(ent.vertices[0].x, ent.vertices[0].y);
                for (let i = 1; i < ent.vertices.length; i++) {
                    currCtx.lineTo(ent.vertices[i].x, ent.vertices[i].y);
                }
                if (ent.closed) currCtx.closePath();
                currCtx.stroke();
            }
            else if (ent.type === EntityType.CIRCLE && ent.center && ent.radius) {
                currCtx.arc(ent.center.x, ent.center.y, ent.radius, 0, 2 * Math.PI);
                currCtx.stroke();
            }
            else if (ent.type === EntityType.ARC && ent.center && ent.radius) {
                const start = (ent.startAngle || 0) * Math.PI / 180;
                const end = (ent.endAngle || 0) * Math.PI / 180;
                currCtx.arc(ent.center.x, ent.center.y, ent.radius, start, end);
                currCtx.stroke();
            }
            else if ((ent.type === EntityType.TEXT || ent.type === EntityType.ATTRIB) && ent.start && ent.text) {
                currCtx.save();
                currCtx.translate(ent.start.x, ent.start.y);
                currCtx.scale(1, -1);
                const angle = (ent.startAngle || 0) * Math.PI / 180;
                currCtx.rotate(-angle);
                const h = ent.radius || 10;
                currCtx.font = `${h}px monospace`;
                // Text is filled (solid), not stroked usually
                const lines = ent.text.split('\n');
                lines.forEach((line, i) => currCtx.fillText(line, 0, i * h * 1.25));
                currCtx.restore();
            }
            // Fallback for Dimensions without blocks (or failed block load)
            else if (ent.type === EntityType.DIMENSION) {
                if (ent.measureStart && ent.measureEnd) {
                    currCtx.moveTo(ent.measureStart.x, ent.measureStart.y);
                    currCtx.lineTo(ent.measureEnd.x, ent.measureEnd.y);
                    currCtx.stroke();
                }
                if (ent.end && ent.text) {
                    currCtx.save();
                    currCtx.translate(ent.end.x, ent.end.y);
                    currCtx.scale(1, -1);
                    const angle = (ent.startAngle || 0) * Math.PI / 180;
                    currCtx.rotate(-angle);
                    const h = 2.5;
                    currCtx.font = `${h}px monospace`;
                    currCtx.textAlign = 'center';
                    currCtx.textBaseline = 'bottom';
                    currCtx.fillText(ent.text, 0, 0);
                    currCtx.restore();
                }
            }
        }
    };


    // --- EXECUTION ---

    // 1. Fill Pass (Off-screen buffer)
    if (filledLayers && filledLayers.size > 0) {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = width;
        offCanvas.height = height;
        const offCtx = offCanvas.getContext('2d');

        if (offCtx) {
            applyTransform(offCtx);
            drawFillsRecursive(offCtx, data.entities, '0');

            ctx.save();
            ctx.globalAlpha = 0.4;
            ctx.drawImage(offCanvas, 0, 0);
            ctx.restore();
        }
    }

    // 2. Stroke Pass (Main Canvas)
    ctx.save();
    applyTransform(ctx);
    drawStrokesRecursive(ctx, data.entities, '0', 1.0);

    // 3. Highlight Pass (Search Results)
    if (highlights && highlights.length > 0) {
        highlights.forEach((h, i) => {
            const isActive = i === activeHighlightIndex;
            ctx.save();

            // Move to insertion point (which bounds.minX/minY represents for Text)
            ctx.translate(h.bounds.minX, h.bounds.minY);

            // Apply text rotation if present
            if (h.rotation) {
                // Rotation in DXF is CCW. In Y-Up coords, rotate(rad) handles this correctly.
                ctx.rotate(h.rotation * Math.PI / 180);
            }

            const w = h.bounds.maxX - h.bounds.minX;
            const hVal = h.bounds.maxY - h.bounds.minY;

            ctx.fillStyle = isActive ? 'rgba(255, 165, 0, 0.7)' : 'rgba(255, 255, 0, 0.35)'; // Orange for active, Yellow for others

            ctx.beginPath();
            // Draw box from origin (0,0) to (w, h) in the local rotated space
            ctx.rect(0, 0, w, hVal);
            ctx.fill();

            if (isActive) {
                ctx.lineWidth = 2 / transform.k;
                ctx.strokeStyle = '#ef4444'; // Red-500
                ctx.stroke();
            }

            ctx.restore();
        });
    }

    ctx.restore();
};
