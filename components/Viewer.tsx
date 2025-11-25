import React, { useRef, useEffect, useState, useCallback } from 'react';
import { DxfData, DxfEntity, EntityType, Bounds, LayerColors } from '../types';
import { ZoomIn, ZoomOut, Maximize, MousePointer2 } from 'lucide-react';

interface ViewerProps {
  data: DxfData | null;
  activeLayers: Set<string>;
  layerColors: LayerColors;
  filledLayers?: Set<string>;
  onRef?: (ref: HTMLCanvasElement | null) => void;
}

export const Viewer: React.FC<ViewerProps> = ({ data, activeLayers, layerColors, filledLayers, onRef }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [lastMouse, setLastMouse] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (onRef) onRef(canvasRef.current);
  }, [onRef]);

  // Calculate Bounds (Recursive for Blocks)
  const getBounds = useCallback((entities: DxfEntity[], blocks: Record<string, DxfEntity[]>): Bounds => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasEntities = false;

    const checkPoint = (x: number, y: number) => {
      // Guard against invalid coordinates
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      
      hasEntities = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };

    const processEntity = (ent: DxfEntity, offsetX = 0, offsetY = 0, scaleX = 1, scaleY = 1, rotation = 0) => {
       const transformAndCheck = (localX: number, localY: number) => {
          let tx = localX * scaleX;
          let ty = localY * scaleY;
          
          if (rotation !== 0) {
              const rad = rotation * Math.PI / 180;
              const cos = Math.cos(rad);
              const sin = Math.sin(rad);
              const rx = tx * cos - ty * sin;
              const ry = tx * sin + ty * cos;
              tx = rx;
              ty = ry;
          }
          checkPoint(tx + offsetX, ty + offsetY);
       };

       if (ent.type === EntityType.LINE && ent.start && ent.end) {
         transformAndCheck(ent.start.x, ent.start.y);
         transformAndCheck(ent.end.x, ent.end.y);
       } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices) {
         ent.vertices.forEach(v => transformAndCheck(v.x, v.y));
       } else if ((ent.type === EntityType.CIRCLE || ent.type === EntityType.ARC) && ent.center && ent.radius) {
         transformAndCheck(ent.center.x - ent.radius, ent.center.y - ent.radius);
         transformAndCheck(ent.center.x + ent.radius, ent.center.y + ent.radius);
       } else if ((ent.type === EntityType.TEXT || ent.type === EntityType.ATTRIB) && ent.start) {
         transformAndCheck(ent.start.x, ent.start.y);
       } else if (ent.type === EntityType.DIMENSION) {
          if (ent.measureStart) transformAndCheck(ent.measureStart.x, ent.measureStart.y);
          if (ent.measureEnd) transformAndCheck(ent.measureEnd.x, ent.measureEnd.y);
          if (ent.end) transformAndCheck(ent.end.x, ent.end.y); 
       } else if (ent.type === EntityType.INSERT && ent.start && ent.blockName && blocks[ent.blockName]) {
          const subEntities = blocks[ent.blockName];
          let insLocalX = ent.start.x * scaleX;
          let insLocalY = ent.start.y * scaleY;
          if (rotation !== 0) {
             const r = rotation * Math.PI / 180;
             const tx = insLocalX * Math.cos(r) - insLocalY * Math.sin(r);
             const ty = insLocalX * Math.sin(r) + insLocalY * Math.cos(r);
             insLocalX = tx;
             insLocalY = ty;
          }
          const nextOffsetX = offsetX + insLocalX;
          const nextOffsetY = offsetY + insLocalY;
          const nextScaleX = scaleX * (ent.scale?.x || 1);
          const nextScaleY = scaleY * (ent.scale?.y || 1);
          const nextRotation = rotation + (ent.rotation || 0);

          subEntities.forEach(sub => processEntity(sub, nextOffsetX, nextOffsetY, nextScaleX, nextScaleY, nextRotation));
       }
    };

    entities.forEach(ent => processEntity(ent));

    if (!hasEntities) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    return { minX, minY, maxX, maxY };
  }, []);

  const fitToScreen = useCallback(() => {
    if (!data || !containerRef.current) return;
    
    const bounds = getBounds(data.entities, data.blocks);
    const rect = containerRef.current.getBoundingClientRect();
    
    let dataWidth = bounds.maxX - bounds.minX;
    let dataHeight = bounds.maxY - bounds.minY;
    
    if (dataWidth <= 0) dataWidth = 100;
    if (dataHeight <= 0) dataHeight = 100;

    const padding = 40;
    const availableWidth = rect.width - (padding * 2);
    const availableHeight = rect.height - (padding * 2);

    const scaleX = availableWidth / dataWidth;
    const scaleY = availableHeight / dataHeight;
    
    let k = Math.min(scaleX, scaleY);
    if (!Number.isFinite(k) || k === 0) k = 1;
    
    const midX = bounds.minX + dataWidth / 2;
    const midY = bounds.minY + dataHeight / 2;

    const x = (rect.width / 2) - midX * k;
    const y = (rect.height / 2) - midY * k;

    setTransform({ k, x, y });
  }, [data, getBounds]);

  useEffect(() => {
    fitToScreen();
  }, [fitToScreen]);

  const handleWheel = (e: React.WheelEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newK = transform.k * zoomFactor;
    const worldX = (mouseX - transform.x) / transform.k;
    const worldY = (rect.height - mouseY - transform.y) / transform.k;
    const newX = mouseX - worldX * newK;
    const newY = rect.height - mouseY - worldY * newK;
    setTransform({ k: newK, x: newX, y: newY });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setLastMouse({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - lastMouse.x;
    const dy = e.clientY - lastMouse.y;
    setLastMouse({ x: e.clientX, y: e.clientY });
    setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y - dy }));
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleZoomBtn = (factor: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const newK = transform.k * factor;
    const worldX = (centerX - transform.x) / transform.k;
    const worldY = (rect.height - centerY - transform.y) / transform.k;
    const newX = centerX - worldX * newK;
    const newY = rect.height - centerY - worldY * newK;
    setTransform({ k: newK, x: newX, y: newY });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !data) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, rect.width, rect.height);
    
    ctx.save();
    ctx.translate(transform.x, rect.height - transform.y);
    ctx.scale(transform.k, -transform.k); 
    
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const drawEntity = (ent: DxfEntity, contextLayer: string, accumulatedScale: number) => {
       if (ent.type === EntityType.ATTRIB && ent.invisible) return;
       if (!Number.isFinite(accumulatedScale) || accumulatedScale === 0) return;

       const effectiveLayer = ent.layer === '0' ? contextLayer : ent.layer;
       if (!activeLayers.has(effectiveLayer)) return;
       
       const color = layerColors[effectiveLayer] || '#e2e8f0';
       ctx.strokeStyle = color;
       ctx.fillStyle = color;

       const lineWidth = Math.max(0.1, 2 / (transform.k * Math.abs(accumulatedScale)));
       ctx.lineWidth = lineWidth;

       ctx.beginPath();

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
           // Check if fill is enabled for this layer
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
      else if (ent.type === EntityType.INSERT && ent.start && ent.blockName && data.blocks[ent.blockName]) {
          const blockEntities = data.blocks[ent.blockName];
          ctx.save();
          ctx.translate(ent.start.x, ent.start.y);
          if (ent.rotation) ctx.rotate(ent.rotation * Math.PI / 180);
          const scaleX = ent.scale?.x || 1;
          const scaleY = ent.scale?.y || 1;
          ctx.scale(scaleX, scaleY);
          const nextAccumulatedScale = accumulatedScale * scaleX;
          blockEntities.forEach(subEnt => drawEntity(subEnt, effectiveLayer, nextAccumulatedScale));
          ctx.restore();
      }
    };

    data.entities.forEach(ent => drawEntity(ent, ent.layer, 1.0));
    ctx.restore();

  }, [data, activeLayers, transform, layerColors, filledLayers]);

  useEffect(() => {
    const handleResize = () => setTransform(t => ({...t})); 
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  if (!data) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-500 border-2 border-dashed border-slate-700 rounded-xl m-4 bg-slate-900/50">
        <div className="text-center">
            <MousePointer2 className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>Upload a DXF file to view</p>
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={containerRef} 
      className="w-full h-full relative bg-slate-900 overflow-hidden cursor-crosshair touch-none select-none"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
      
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-slate-800/90 backdrop-blur border border-slate-700 p-1.5 rounded-full shadow-xl">
        <button onClick={() => handleZoomBtn(0.8)} className="p-2 hover:bg-slate-700 rounded-full text-slate-300 hover:text-white transition-colors" title="Zoom Out">
            <ZoomOut size={18} />
        </button>
        <div className="w-px h-4 bg-slate-600 mx-1"></div>
        <span className="text-xs text-slate-300 font-mono w-16 text-center select-none">
            {Math.round(transform.k * 100)}%
        </span>
        <div className="w-px h-4 bg-slate-600 mx-1"></div>
        <button onClick={fitToScreen} className="p-2 hover:bg-slate-700 rounded-full text-blue-400 hover:text-blue-300 transition-colors" title="Fit to Screen">
            <Maximize size={18} />
        </button>
        <div className="w-px h-4 bg-slate-600 mx-1"></div>
        <button onClick={() => handleZoomBtn(1.2)} className="p-2 hover:bg-slate-700 rounded-full text-slate-300 hover:text-white transition-colors" title="Zoom In">
            <ZoomIn size={18} />
        </button>
      </div>
    </div>
  );
};