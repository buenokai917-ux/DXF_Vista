
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { DxfData, LayerColors, Bounds, SearchResult, SemanticLayer } from '../types';
import { ZoomIn, ZoomOut, Maximize, MousePointer2, Crosshair } from 'lucide-react';
import { calculateTotalBounds, findLayersAtPoint } from '../utils/geometryUtils';
import { renderDxfToCanvas } from '../utils/renderUtils';

interface ViewerProps {
  data: DxfData | null;
  activeLayers: Set<string>;
  layerColors: LayerColors;
  filledLayers?: Set<string>;
  targetBounds?: Bounds | null; // For auto-focus
  highlights?: SearchResult[]; // For search result highlighting
  activeHighlightIndex?: number;
  onRef?: (ref: HTMLCanvasElement | null) => void;
  projectName?: string;
  pickingTarget?: SemanticLayer | null;
  onLayerPicked?: (layer: string) => void;
}

export const Viewer: React.FC<ViewerProps> = ({ 
  data, 
  activeLayers, 
  layerColors, 
  filledLayers, 
  targetBounds, 
  highlights, 
  activeHighlightIndex, 
  onRef,
  projectName,
  pickingTarget,
  onLayerPicked
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [lastMouse, setLastMouse] = useState({ x: 0, y: 0 });
  
  // Track if mouse moved during a press to distinguish Click from Drag
  const hasMoved = useRef(false);
  
  // Inspection State
  const [mouseWorldPos, setMouseWorldPos] = useState<{x: number, y: number} | null>(null);
  const [hoveredLayers, setHoveredLayers] = useState<string[]>([]);
  const lastHitTestTime = useRef(0);

  useEffect(() => {
    if (onRef) onRef(canvasRef.current);
  }, [onRef]);

  const fitToScreen = useCallback(() => {
    if (!data || !containerRef.current) return;
    
    // Use the shared bound calculation, but filter by active layers for better fit
    const bounds = calculateTotalBounds(data.entities, data.blocks, activeLayers);
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
  }, [data, activeLayers]);

  // Fit to screen on initial load or data change only.
  useEffect(() => {
    fitToScreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // --- Focus on Target Bounds (Search Result) ---
  useEffect(() => {
    if (!targetBounds || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    
    // Center of the target
    const targetCenterX = (targetBounds.minX + targetBounds.maxX) / 2;
    const targetCenterY = (targetBounds.minY + targetBounds.maxY) / 2;
    
    // Dimensions of the target
    const targetW = targetBounds.maxX - targetBounds.minX;
    const targetH = targetBounds.maxY - targetBounds.minY;

    // Determine appropriate zoom level
    // Ensure we have some context around the text (at least 6x the text size, or min 5000 units)
    const contextW = Math.max(targetW * 6, 5000); 
    const contextH = Math.max(targetH * 6, 5000);
    
    const scaleX = rect.width / contextW;
    const scaleY = rect.height / contextH;
    
    // Choose the smaller scale to fit context, but cap max zoom to avoid getting too close
    let newK = Math.min(scaleX, scaleY);
    
    // Center the view
    const newX = (rect.width / 2) - targetCenterX * newK;
    const newY = (rect.height / 2) - targetCenterY * newK;

    setTransform({ k: newK, x: newX, y: newY });

  }, [targetBounds]);

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
    hasMoved.current = false;
    setIsDragging(true);
    setLastMouse({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    // 1. Calculate World Coordinates
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const worldX = (mouseX - transform.x) / transform.k;
    const worldY = (rect.height - mouseY - transform.y) / transform.k;
    
    setMouseWorldPos({ x: worldX, y: worldY });

    // 2. Dragging Logic
    if (isDragging) {
        const dx = e.clientX - lastMouse.x;
        const dy = e.clientY - lastMouse.y;
        
        // Threshold check to confirm drag intention vs jittery click
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
             hasMoved.current = true;
        }

        setLastMouse({ x: e.clientX, y: e.clientY });
        setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y - dy })); 
    }

    // 3. Throttled Hit Test
    if (data) {
        const now = Date.now();
        if (now - lastHitTestTime.current > 50) { // Check every 50ms
            const tolerance = 10 / transform.k; // 10 screen pixels tolerance
            const layers = findLayersAtPoint({x: worldX, y: worldY}, data.entities, data.blocks, data.blockBasePoints, activeLayers, tolerance);
            setHoveredLayers(layers);
            lastHitTestTime.current = now;
        }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    setIsDragging(false);

    // If we are in picking mode and the mouse hasn't moved significantly, treat as a Click/Pick
    if (pickingTarget && !hasMoved.current && data && onLayerPicked && containerRef.current) {
         const rect = containerRef.current.getBoundingClientRect();
         const worldX = (e.clientX - rect.left - transform.x) / transform.k;
         const worldY = (rect.height - (e.clientY - rect.top) - transform.y) / transform.k;
         const tolerance = 15 / transform.k; // slightly larger tolerance for picking
         
         const layers = findLayersAtPoint(
            {x: worldX, y: worldY}, 
            data.entities, 
            data.blocks, 
            data.blockBasePoints, 
            activeLayers, 
            tolerance
         );
         
         if (layers.length > 0) {
             onLayerPicked(layers[0]);
         }
    }
  };

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
    
    renderDxfToCanvas({
        ctx,
        data,
        activeLayers,
        layerColors,
        filledLayers,
        transform,
        width: rect.width,
        height: rect.height,
        isPdfExport: false,
        highlights,
        activeHighlightIndex
    });

  }, [data, activeLayers, transform, layerColors, filledLayers, highlights, activeHighlightIndex]);

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
      className={`w-full h-full relative bg-slate-900 overflow-hidden touch-none select-none ${pickingTarget ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
      
      {/* Picking Overlay Indicator */}
      {pickingTarget && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-blue-600/90 text-white px-4 py-2 rounded-full shadow-lg border border-blue-400 backdrop-blur-md z-50 flex items-center gap-2 animate-pulse">
            <Crosshair size={16} />
            <span className="text-xs font-semibold uppercase tracking-wider">Picking {pickingTarget.replace('_', ' ')}...</span>
        </div>
      )}

      {/* Top Right Overlay Container: Inspection & File Info */}
      <div className="absolute top-4 right-4 pointer-events-none flex items-start gap-3">
          
          {/* Mouse Inspection (Left side of overlay) */}
          {mouseWorldPos && (
              <div className="flex flex-col items-end gap-2">
                  <div className="bg-slate-800/80 backdrop-blur px-3 py-1.5 rounded border border-slate-700 text-[10px] font-mono text-slate-300 shadow-lg whitespace-nowrap">
                      X: {mouseWorldPos.x.toFixed(0)}, Y: {mouseWorldPos.y.toFixed(0)}
                  </div>
                  {hoveredLayers.length > 0 && (
                      <div className="bg-slate-800/80 backdrop-blur px-3 py-2 rounded border border-slate-700 shadow-lg text-right">
                          <div className="text-[10px] text-slate-500 uppercase font-bold mb-1">Layers Detected</div>
                          {hoveredLayers.slice(0, 5).map(l => (
                              <div key={l} className="text-xs text-blue-300 font-mono">
                                  {l}
                              </div>
                          ))}
                          {hoveredLayers.length > 5 && (
                              <div className="text-[10px] text-slate-500 italic">
                                  +{hoveredLayers.length - 5} more
                              </div>
                          )}
                      </div>
                  )}
              </div>
          )}

          {/* File Info (Right side of overlay, persistent) */}
          <div className="bg-slate-900/90 border border-slate-700 rounded-lg p-3 text-xs text-slate-400 backdrop-blur-sm shadow-xl">
               <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                 <span className="font-semibold text-slate-500">File:</span>
                 <span className="text-right text-slate-300 max-w-[150px] truncate">{projectName || 'Unknown'}</span>
                 <span className="font-semibold">Entities:</span>
                 <span className="text-right text-slate-200">{data?.entities.length || 0}</span>
                 <span className="font-semibold">Layers:</span>
                 <span className="text-right text-slate-200">{data?.layers.length || 0}</span>
               </div>
          </div>

      </div>

      {/* Bottom Center Controls */}
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
