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

  // Calculate Bounds
  const getBounds = useCallback((entities: DxfEntity[]): Bounds => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasEntities = false;

    const checkPoint = (p?: Point) => {
      if (!p) return;
      hasEntities = true;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    };

    entities.forEach(ent => {
      if (ent.type === EntityType.LINE) {
        checkPoint(ent.start);
        checkPoint(ent.end);
      } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices) {
        ent.vertices.forEach(checkPoint);
      } else if (ent.type === EntityType.CIRCLE || ent.type === EntityType.ARC) {
        if (ent.center && ent.radius) {
          checkPoint({ x: ent.center.x - ent.radius, y: ent.center.y - ent.radius });
          checkPoint({ x: ent.center.x + ent.radius, y: ent.center.y + ent.radius });
        }
      } else if ((ent.type === EntityType.TEXT || ent.type === EntityType.INSERT) && ent.start) {
        checkPoint(ent.start);
      } else if (ent.type === EntityType.DIMENSION) {
          checkPoint(ent.start); 
          checkPoint(ent.end); 
      }
    });

    if (!hasEntities) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    return { minX, minY, maxX, maxY };
  }, []);

  // Fit view to screen
  const fitToScreen = useCallback(() => {
    if (!data || !containerRef.current) return;
    
    const bounds = getBounds(data.entities);
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

    ctx.lineWidth = 1; 
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    data.entities.forEach(ent => {
      if (!activeLayers.has(ent.layer)) return;

      const color = layerColors[ent.layer] || '#e2e8f0';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      ctx.beginPath();

      if (ent.type === EntityType.LINE && ent.start && ent.end) {
        ctx.moveTo(toScreenX(ent.start.x), toScreenY(ent.start.y));
        ctx.lineTo(toScreenX(ent.end.x), toScreenY(ent.end.y));
        ctx.stroke();
      } 
      else if (ent.type === EntityType.LWPOLYLINE && ent.vertices && ent.vertices.length > 0) {
        ctx.moveTo(toScreenX(ent.vertices[0].x), toScreenY(ent.vertices[0].y));
        for (let i = 1; i < ent.vertices.length; i++) {
          ctx.lineTo(toScreenX(ent.vertices[i].x), toScreenY(ent.vertices[i].y));
        }
        if (ent.closed) ctx.closePath();
        ctx.stroke();
      }
      else if (ent.type === EntityType.CIRCLE && ent.center && ent.radius) {
        const cx = toScreenX(ent.center.x);
        const cy = toScreenY(ent.center.y);
        const r = ent.radius * transform.k;
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.stroke();
      }
      else if (ent.type === EntityType.ARC && ent.center && ent.radius && ent.startAngle !== undefined && ent.endAngle !== undefined) {
        const cx = toScreenX(ent.center.x);
        const cy = toScreenY(ent.center.y);
        const r = ent.radius * transform.k;
        // DXF Angles are CCW from X-axis. Canvas Arc is CW? No, standard arc is CCW.
        // But our Y axis is inverted (Screen Y vs World Y). 
        // World 0 deg = Right. World 90 deg = Up.
        // Screen 0 deg = Right. Screen 90 deg = Down.
        // So World Angle theta becomes Screen Angle -theta.
        const startRad = -(ent.startAngle * Math.PI / 180);
        const endRad = -(ent.endAngle * Math.PI / 180);
        
        ctx.arc(cx, cy, r, startRad, endRad, true); // true = CounterClockwise in Canvas? 
        // Actually, since we flipped the sign, we need to check arc direction.
        // Dxf arc goes from start to end CCW.
        // -Start to -End is CW visually?
        // Let's rely on standard 'true' (counterclockwise) for our inverted angles.
        ctx.stroke();
      }
      else if (ent.type === EntityType.TEXT && ent.start && ent.text) {
          const x = toScreenX(ent.start.x);
          const y = toScreenY(ent.start.y);
          const height = Math.max(10, (ent.radius || 10) * transform.k);
          
          ctx.save();
          ctx.translate(x, y);
          
          // Rotation handling
          // DXF rotation is in degrees CCW.
          // Because Y is flipped in our screen projection, we flip the rotation direction.
          const rotationRad = (ent.startAngle || 0) * (Math.PI / 180);
          ctx.rotate(-rotationRad);

          ctx.font = `${height}px monospace`;
          // DXF Text alignment varies, defaulting to left baseline for now
          ctx.fillText(ent.text, 0, 0);
          ctx.restore();
      }
      else if (ent.type === EntityType.DIMENSION) {
        if (ent.end && ent.text) {
          ctx.save();
          ctx.translate(toScreenX(ent.end.x), toScreenY(ent.end.y));
          
          // Try to respect rotation if present (Dimensions often align with element)
          // For now, draw horizontal
          ctx.font = `12px monospace`;
          ctx.fillText(ent.text, 0, 0);
          ctx.restore();
        } else if (ent.end) {
          ctx.save();
          ctx.translate(toScreenX(ent.end.x), toScreenY(ent.end.y));
          ctx.font = `10px monospace`;
          ctx.fillText("DIM", 0, 0);
          ctx.restore();
        }
      }
      else if (ent.type === EntityType.INSERT && ent.start) {
          const x = toScreenX(ent.start.x);
          const y = toScreenY(ent.start.y);
          const size = 6;
          
          ctx.save();
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.5;
          ctx.beginPath();
          ctx.moveTo(x - size, y - size);
          ctx.lineTo(x + size, y + size);
          ctx.moveTo(x + size, y - size);
          ctx.lineTo(x - size, y + size);
          ctx.stroke();
          ctx.restore();
      }
    });

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