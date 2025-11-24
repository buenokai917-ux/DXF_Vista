import React, { useRef, useEffect, useState, useCallback } from 'react';
import { DxfData, DxfEntity, EntityType, Bounds, Point, LayerColors } from '../types';
import { ZoomIn, ZoomOut, Maximize, MousePointer2 } from 'lucide-react';

interface ViewerProps {
  data: DxfData | null;
  activeLayers: Set<string>;
  layerColors: LayerColors;
  onRef?: (ref: HTMLCanvasElement | null) => void;
}

export const Viewer: React.FC<ViewerProps> = ({ data, activeLayers, layerColors, onRef }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [lastMouse, setLastMouse] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (onRef) onRef(canvasRef.current);
  }, [onRef]);

  // Calculate Bounds (Recursive for Blocks)
  const getBounds = useCallback((entities: DxfEntity[], blocks?: Record<string, DxfEntity[]>): Bounds => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasEntities = false;

    const checkPoint = (x: number, y: number) => {
      hasEntities = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };

    const processEntity = (ent: DxfEntity, offsetX = 0, offsetY = 0) => {
       if (ent.type === EntityType.LINE && ent.start && ent.end) {
         checkPoint(ent.start.x + offsetX, ent.start.y + offsetY);
         checkPoint(ent.end.x + offsetX, ent.end.y + offsetY);
       } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices) {
         ent.vertices.forEach(v => checkPoint(v.x + offsetX, v.y + offsetY));
       } else if ((ent.type === EntityType.CIRCLE || ent.type === EntityType.ARC) && ent.center && ent.radius) {
         checkPoint(ent.center.x + offsetX - ent.radius, ent.center.y + offsetY - ent.radius);
         checkPoint(ent.center.x + offsetX + ent.radius, ent.center.y + offsetY + ent.radius);
       } else if ((ent.type === EntityType.TEXT || ent.type === EntityType.INSERT) && ent.start) {
         checkPoint(ent.start.x + offsetX, ent.start.y + offsetY);
       } else if (ent.type === EntityType.DIMENSION) {
          if (ent.measureStart) checkPoint(ent.measureStart.x + offsetX, ent.measureStart.y + offsetY);
          if (ent.measureEnd) checkPoint(ent.measureEnd.x + offsetX, ent.measureEnd.y + offsetY);
          if (ent.start) checkPoint(ent.start.x + offsetX, ent.start.y + offsetY);
          if (ent.end) checkPoint(ent.end.x + offsetX, ent.end.y + offsetY);
       }
    };

    entities.forEach(ent => processEntity(ent));

    if (!hasEntities) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    return { minX, minY, maxX, maxY };
  }, []);

  // Fit view to screen
  const fitToScreen = useCallback(() => {
    if (!data || !containerRef.current) return;
    
    const bounds = getBounds(data.entities, data.blocks);
    const rect = containerRef.current.getBoundingClientRect();
    
    const dataWidth = bounds.maxX - bounds.minX;
    const dataHeight = bounds.maxY - bounds.minY;
    
    if (dataWidth === 0 || dataHeight === 0) {
        setTransform({ k: 1, x: 0, y: 0 });
        return;
    }

    const padding = 40;
    const availableWidth = rect.width - (padding * 2);
    const availableHeight = rect.height - (padding * 2);

    const scaleX = availableWidth / dataWidth;
    const scaleY = availableHeight / dataHeight;
    const k = Math.min(scaleX, scaleY);
    
    const midX = bounds.minX + dataWidth / 2;
    const midY = bounds.minY + dataHeight / 2;

    const x = (rect.width / 2) - midX * k;
    const y = (rect.height / 2) - midY * k;

    setTransform({ k, x, y });
  }, [data, getBounds]);

  useEffect(() => {
    fitToScreen();
  }, [fitToScreen]);

  // --- Interaction Handlers ---
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

  // --- Drawing ---
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
    
    const toScreenX = (x: number) => x * transform.k + transform.x;
    const toScreenY = (y: number) => rect.height - (y * transform.k + transform.y);

    // Set consistent line width (~2px visual width)
    const visualLineWidth = 2;
    ctx.lineWidth = visualLineWidth / transform.k; 
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Helper to draw a single entity
    const drawEntity = (ent: DxfEntity, contextLayer: string) => {
       const effectiveLayer = ent.layer === '0' ? contextLayer : ent.layer;
       if (!activeLayers.has(effectiveLayer)) return;
       
       const color = layerColors[effectiveLayer] || '#e2e8f0';
       ctx.strokeStyle = color;
       ctx.fillStyle = color;

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
        if (ent.closed) ctx.closePath();
        ctx.stroke();
      }
      else if (ent.type === EntityType.CIRCLE && ent.center && ent.radius) {
        ctx.arc(ent.center.x, ent.center.y, ent.radius, 0, 2 * Math.PI);
        ctx.stroke();
      }
      else if (ent.type === EntityType.ARC && ent.center && ent.radius && ent.startAngle !== undefined && ent.endAngle !== undefined) {
        // DXF angles are in degrees CCW. Canvas arc takes radians.
        const startRad = ent.startAngle * Math.PI / 180;
        const endRad = ent.endAngle * Math.PI / 180;
        ctx.arc(ent.center.x, ent.center.y, ent.radius, startRad, endRad);
        ctx.stroke();
      }
      else if (ent.type === EntityType.TEXT && ent.start && ent.text) {
          ctx.save();
          ctx.translate(ent.start.x, ent.start.y);
          
          // Fix for upside-down text:
          // 1. Un-flip the Y axis locally (because global context is Y-flipped)
          ctx.scale(1, -1);
          // 2. Rotate. Since Y is now 'down' (visual), but DXF angle is CCW,
          //    and canvas rotate is CW, we invert the angle.
          ctx.rotate(-(ent.startAngle || 0) * Math.PI / 180);
          
          const height = ent.radius || 10; 
          ctx.font = `${height}px monospace`;
          ctx.fillText(ent.text, 0, 0); // Default baseline left
          ctx.restore();
      }
      else if (ent.type === EntityType.DIMENSION) {
        // Draw measurement line
        if (ent.measureStart && ent.measureEnd) {
           ctx.moveTo(ent.measureStart.x, ent.measureStart.y);
           ctx.lineTo(ent.measureEnd.x, ent.measureEnd.y);
           ctx.stroke();
        }
        // Draw text
        if (ent.end && ent.text) {
           ctx.save();
           ctx.translate(ent.end.x, ent.end.y);
           ctx.scale(1, -1); // Fix upside down text
           // Dimensions usually align with line, but for now draw horizontal or use default
           const height = 2.5;
           ctx.font = `${height}px monospace`;
           ctx.fillText(ent.text, 0, 0);
           ctx.restore();
        }
      }
      else if (ent.type === EntityType.INSERT && ent.start && ent.blockName && data.blocks[ent.blockName]) {
          const blockEntities = data.blocks[ent.blockName];
          ctx.save();
          ctx.translate(ent.start.x, ent.start.y);
          if (ent.rotation) ctx.rotate(ent.rotation * Math.PI / 180);
          if (ent.scale) ctx.scale(ent.scale.x, ent.scale.y);
          
          blockEntities.forEach(subEnt => drawEntity(subEnt, effectiveLayer));
          
          ctx.restore();
      }
    };

    ctx.save();
    
    // Global transform: Move, Zoom, and Flip Y axis (DXF Y is up)
    ctx.translate(transform.x, rect.height - transform.y);
    ctx.scale(transform.k, -transform.k); 
    
    data.entities.forEach(ent => drawEntity(ent, ent.layer));
    
    ctx.restore();

  }, [data, activeLayers, transform, layerColors]);

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
        <button onClick={fitToScreen} className="p-2 hover:bg-slate-700 rounded-full text-blue-400 hover:text-blue-300 transition-colors" title="Fit to Screen">
            <Maximize size={18} />
        </button>
        <div className="w-px h-4 bg-slate-600 mx-1"></div>
        <button onClick={() => handleZoomBtn(1.2)} className="p-2 hover:bg-slate-700 rounded-full text-slate-300 hover:text-white transition-colors" title="Zoom In">
            <ZoomIn size={18} />
        </button>
      </div>

      <div className="absolute top-4 right-4 bg-slate-800/80 px-3 py-1 rounded text-xs text-slate-400 pointer-events-none border border-slate-700/50">
        Zoom: {transform.k.toFixed(2)}x
      </div>
    </div>
  );
};