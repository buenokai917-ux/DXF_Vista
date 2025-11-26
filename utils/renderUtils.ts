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
    isPdfExport?: boolean; // If true, optimizes for white background (inverts/darkens colors, adjusts weights)
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
    // Clear background
    if (isPdfExport) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
    } else {
        ctx.fillStyle = '#0f172a'; // Slate 900
        ctx.fillRect(0, 0, width, height);
    }
    
    ctx.save();
    // Apply Transform: Translate to pan, Scale for zoom/fit
    // Note: Canvas Y is down, DXF Y is up. We usually handle this by scaling Y by -k and translating.
    ctx.translate(transform.x, height - transform.y);
    ctx.scale(transform.k, -transform.k); 
    
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const drawEntity = (ent: DxfEntity, contextLayer: string, accumulatedScale: number) => {
       if (ent.type === EntityType.ATTRIB && ent.invisible) return;
       if (!Number.isFinite(accumulatedScale) || accumulatedScale === 0) return;

       const effectiveLayer = ent.layer === '0' ? contextLayer : ent.layer;
       const isLayerActive = activeLayers.has(effectiveLayer);

       // Skip primitives if layer is not active. 
       // IMPORTANT: Do NOT skip INSERTs here; we must traverse them to find nested visible items.
       if (!isLayerActive && ent.type !== EntityType.INSERT) return;
       
       // Setup Styling (Color, LineWidth) only if this entity itself is active
       // (INSERTs don't draw directly, so we don't strictly need to set style for them, 
       // but we do need to calculate `color` for children if they use Layer 0)
       if (isLayerActive) {
           let color = layerColors[effectiveLayer] || '#e2e8f0';

           // --- Color Optimization for White Background (PDF/Export) ---
           if (isPdfExport) {
               const c = color.toLowerCase();
               // Invert White to Black
               if (c === '#ffffff' || c === '#fff') {
                   color = '#000000';
               } 
               // Darken standard bright colors that are hard to see on white paper
               else if (c === '#ffff00') color = '#eab308'; // Yellow -> Darker Yellow/Gold
               else if (c === '#00ffff') color = '#0891b2'; // Cyan -> Cyan-700
               else if (c === '#00ff00') color = '#16a34a'; // Green -> Green-600
           }

           ctx.strokeStyle = color;
           ctx.fillStyle = color;

           // --- Line Width Optimization ---
           const targetPixelWidth = isPdfExport ? 2 : 1; 
           const lineWidth = targetPixelWidth / (transform.k * Math.abs(accumulatedScale));
           ctx.lineWidth = lineWidth;
       }

       ctx.beginPath();

       // Draw Primitives (Only if active)
       if (isLayerActive) {
           if (ent.type === EntityType.LINE && ent.start && ent.end) {
            ctx.moveTo(ent.start.x, ent.start.y);
            ctx.lineTo(ent.end.x, ent.end.y);
            ctx.stroke();
          } 
          else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 0) {
            ctx.moveTo(ent.vertices[0].x, ent.vertices[0].y);
            for (let i = 1; i < ent.vertices.length; i++) {
              ctx.lineTo(ent.vertices[i].x, ent.vertices[i].y);
            }
            if (ent.closed) {
               ctx.closePath();
               if (filledLayers && filledLayers.has(effectiveLayer)) {
                   ctx.save();
                   ctx.globalAlpha = 0.3;
                   ctx.fill();
                   ctx.restore();
               }
            }
            ctx.stroke();
          }
          else if (ent.type === EntityType.CIRCLE && ent.center && ent.radius) {
            ctx.arc(ent.center.x, ent.center.y, ent.radius, 0, 2 * Math.PI);
            ctx.stroke();
          }
          else if (ent.type === EntityType.ARC && ent.center && ent.radius && ent.startAngle !== undefined && ent.endAngle !== undefined) {
            const startRad = ent.startAngle * Math.PI / 180;
            const endRad = ent.endAngle * Math.PI / 180;
            ctx.arc(ent.center.x, ent.center.y, ent.radius, startRad, endRad);
            ctx.stroke();
          }
          else if ((ent.type === EntityType.TEXT || ent.type === EntityType.ATTRIB) && ent.start && ent.text) {
              ctx.save();
              ctx.translate(ent.start.x, ent.start.y);
              ctx.scale(1, -1);
              const angle = (ent.startAngle || 0) * Math.PI / 180;
              ctx.rotate(-angle);
              const height = ent.radius || 10; 
              ctx.font = `${height}px monospace`;
              const lines = ent.text.split('\n');
              lines.forEach((line, i) => {
                ctx.fillText(line, 0, i * height * 1.25);
              });
              ctx.restore();
          }
          else if (ent.type === EntityType.DIMENSION) {
            if (ent.measureStart && ent.measureEnd) {
               ctx.moveTo(ent.measureStart.x, ent.measureStart.y);
               ctx.lineTo(ent.measureEnd.x, ent.measureEnd.y);
               ctx.stroke();
            }
            if (ent.end && ent.text) {
               ctx.save();
               ctx.translate(ent.end.x, ent.end.y);
               ctx.scale(1, -1);
               const angle = (ent.startAngle || 0) * Math.PI / 180;
               ctx.rotate(-angle);
               const height = 2.5; 
               ctx.font = `${height}px monospace`;
               ctx.textAlign = 'center';
               ctx.textBaseline = 'bottom';
               ctx.fillText(ent.text, 0, 0);
               ctx.restore();
            }
          }
       }
       
       // Handle INSERT & MINSERT (Always traverse, even if layer is inactive)
       if (ent.type === EntityType.INSERT && ent.start && ent.blockName && data.blocks[ent.blockName]) {
          const blockEntities = data.blocks[ent.blockName];
          
          // MINSERT Support
          const rows = ent.rowCount || 1;
          const cols = ent.columnCount || 1;
          const rSpace = ent.rowSpacing || 0;
          const cSpace = ent.columnSpacing || 0;

          const renderBlockAt = (offsetX: number, offsetY: number) => {
              ctx.save();
              // Apply Block Base Point Correction if available
              // (Note: Parser now puts everything relative to 0,0 usually, but if blockBasePoints exist 
              // we might need to subtract them. However, standard behavior for 'INSERT' is:
              // InsertionPoint = WorldCoord. Block Content is drawn relative to BasePoint.
              // So we translate to InsertionPoint. 
              // IF the content inside is raw coordinates, we assume BasePoint was (0,0).
              // If BasePoint is (X,Y), we must shift content by (-X, -Y).
              
              const basePoint = data.blockBasePoints[ent.blockName!] || { x: 0, y: 0 };

              ctx.translate(ent.start!.x + offsetX, ent.start!.y + offsetY);
              if (ent.rotation) ctx.rotate(ent.rotation * Math.PI / 180);
              
              const scaleX = ent.scale?.x || 1;
              const scaleY = ent.scale?.y || 1;
              ctx.scale(scaleX, scaleY);
              
              // Apply Base Point Subtraction
              ctx.translate(-basePoint.x, -basePoint.y);

              const nextAccumulatedScale = accumulatedScale * scaleX;
              
              blockEntities.forEach(subEnt => drawEntity(subEnt, effectiveLayer, nextAccumulatedScale));
              ctx.restore();
          };

          if (rows === 1 && cols === 1) {
              renderBlockAt(0, 0);
          } else {
             for (let r = 0; r < rows; r++) {
                 for (let c = 0; c < cols; c++) {
                     renderBlockAt(c * cSpace, r * rSpace);
                 }
             }
          }
       }
    };

    data.entities.forEach(ent => drawEntity(ent, ent.layer, 1.0));
    ctx.restore();
};