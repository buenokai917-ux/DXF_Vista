import { DxfData, DxfEntity, EntityType, LayerColors } from '../types';

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
}

export const renderDxfToCanvas = ({
    ctx,
    data,
    activeLayers,
    layerColors,
    filledLayers,
    transform,
    width,
    height,
    isPdfExport = false
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

    // 3. Separate Entities into "Fills" (Walls) and "Strokes" (Everything else)
    const filledEntities: { ent: DxfEntity, color: string, layer: string }[] = [];
    const strokeEntities: { ent: DxfEntity, color: string, layer: string, lineWidth: number }[] = [];

    const targetPixelWidth = isPdfExport ? 2 : 1;
    const baseLineWidth = targetPixelWidth / transform.k;

    const processEntity = (ent: DxfEntity, contextLayer: string, accumulatedScale: number, rotation: number, offset: {x:number, y:number}) => {
       if (ent.type === EntityType.ATTRIB && ent.invisible) return;
       if (!Number.isFinite(accumulatedScale) || accumulatedScale === 0) return;

       const effectiveLayer = ent.layer === '0' ? contextLayer : ent.layer;
       const isLayerActive = activeLayers.has(effectiveLayer);

       if (!isLayerActive && ent.type !== EntityType.INSERT) return;

       if (ent.type === EntityType.INSERT && ent.start && ent.blockName && data.blocks[ent.blockName]) {
           const blockEnts = data.blocks[ent.blockName];
           const basePoint = data.blockBasePoints[ent.blockName!] || { x: 0, y: 0 };
           
           const rows = ent.rowCount || 1;
           const cols = ent.columnCount || 1;
           const rSpace = ent.rowSpacing || 0;
           const cSpace = ent.columnSpacing || 0;
           
           const scaleX = ent.scale?.x || 1;
           const scaleY = ent.scale?.y || 1;
           const blkRot = ent.rotation || 0;

           const nextScale = accumulatedScale * Math.abs(scaleX); // Simplified scale tracking
           const nextRot = rotation + blkRot;

           for (let r = 0; r < rows; r++) {
               for (let c = 0; c < cols; c++) {
                   // Calculate grid position in Local Block Space
                   const gridX = c * cSpace;
                   const gridY = r * rSpace;

                   // Transform grid pos by Block Rotation
                   const rad = blkRot * Math.PI / 180;
                   const rx = gridX * Math.cos(rad) - gridY * Math.sin(rad);
                   const ry = gridX * Math.sin(rad) + gridY * Math.cos(rad);

                   // Block Insertion Point in Parent Space
                   const insX = ent.start!.x;
                   const insY = ent.start!.y;

                   // Apply Parent Rotation/Scale/Offset to the Insertion Point + Grid Offset
                   // NOTE: We recursively pass transform down, so we just need to pass the accumulation.
                   // Actually, for flattened recursion without matrix stack, it's easier to recurse logic.
                   // But here we are building a flat list. 
                   
                   // To keep it simple in this specific refactor without full matrix math, 
                   // we will use the Recursive Draw approach directly on the Canvas Contexts 
                   // instead of pre-calculating flattened coordinates. 
                   // So we abort this "Flattening" strategy and go back to recursive drawing, 
                   // but splitting the passes.
               }
           }
       }
    };

    // 4. Color Logic
    const getColor = (layer: string) => {
        let color = layerColors[layer] || '#e2e8f0';
        if (isPdfExport) {
            const c = color.toLowerCase();
            if (c === '#ffffff' || c === '#fff') color = '#000000';
            else if (c === '#ffff00') color = '#eab308';
            else if (c === '#00ffff') color = '#0891b2';
            else if (c === '#00ff00') color = '#16a34a';
        }
        return color;
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

            if (!isLayerActive) continue;

            // Only draw filled polygons if the layer is marked as FILLED
            if (filledLayers && filledLayers.has(effectiveLayer)) {
                if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.closed) {
                    currCtx.fillStyle = getColor(effectiveLayer);
                    currCtx.beginPath();
                    currCtx.moveTo(ent.vertices[0].x, ent.vertices[0].y);
                    for (let i = 1; i < ent.vertices.length; i++) {
                        currCtx.lineTo(ent.vertices[i].x, ent.vertices[i].y);
                    }
                    currCtx.closePath();
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

            if (!isLayerActive) continue;

            currCtx.strokeStyle = getColor(effectiveLayer);
            currCtx.fillStyle = getColor(effectiveLayer); // For Text
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
                // Note: We do NOT fill here. Fills are handled in the Fill Pass.
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
    // We create a temporary canvas to render ALL filled layers opaquely.
    // This merges intersections (T-junctions, Corners) into a single silhouette.
    if (filledLayers && filledLayers.size > 0) {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = width;
        offCanvas.height = height;
        const offCtx = offCanvas.getContext('2d');
        
        if (offCtx) {
            applyTransform(offCtx);
            drawFillsRecursive(offCtx, data.entities, '0');
            
            // Draw the buffer onto the main canvas with global opacity
            ctx.save();
            ctx.globalAlpha = 0.4; // Unified transparency
            ctx.drawImage(offCanvas, 0, 0);
            ctx.restore();
        }
    }

    // 2. Stroke Pass (Main Canvas)
    // Draw all outlines and non-filled entities on top for crisp edges.
    ctx.save();
    applyTransform(ctx);
    drawStrokesRecursive(ctx, data.entities, '0', 1.0);
    ctx.restore();
};