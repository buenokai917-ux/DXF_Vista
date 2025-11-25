import React, { useState, useRef, useEffect, useMemo } from 'react';
import { jsPDF } from 'jspdf';
import { parseDxf } from './utils/dxfParser';
import { DxfData, LayerColors, DxfEntity, EntityType, Point } from './types';
import { getBeamProperties, getCenter, transformPoint, findParallelPolygons, calculateLength } from './utils/geometryUtils';
import { Viewer } from './components/Viewer';
import { Button } from './components/Button';
import { Upload, Layers, Download, Image as ImageIcon, FileText, Settings, X, RefreshCw, Globe, Search, Calculator, Boxes } from 'lucide-react';

// Standard CAD Colors (Index 1-7 + Grays)
const CAD_COLORS = [
  '#FF0000', // Red
  '#FFFF00', // Yellow
  '#00FF00', // Green
  '#00FFFF', // Cyan
  '#0000FF', // Blue
  '#FF00FF', // Magenta
  '#FFFFFF', // White
  '#808080', // Gray
  '#C0C0C0', // Light Gray
  '#FFA500', // Orange
  '#A52A2A', // Brown
];

interface Transform {
  scale: Point;
  rotation: number;
  translation: Point;
}

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState<string>('utf-8');
  const [data, setData] = useState<DxfData | null>(null);
  const [activeLayers, setActiveLayers] = useState<Set<string>>(new Set());
  const [filledLayers, setFilledLayers] = useState<Set<string>>(new Set());
  const [layerColors, setLayerColors] = useState<LayerColors>({});
  const [layerSearchTerm, setLayerSearchTerm] = useState('');
  const [isSidebarOpen, setSidebarOpen] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const ENCODINGS = [
    { label: 'UTF-8 (Default)', value: 'utf-8' },
    { label: 'GBK (Chinese)', value: 'gbk' },
    { label: 'Big5 (Trad. Chinese)', value: 'big5' },
    { label: 'Shift_JIS (Japanese)', value: 'shift_jis' },
    { label: 'Windows-1252 (Latin)', value: 'windows-1252' },
  ];

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0];
    if (!uploadedFile) return;
    setFile(uploadedFile);
  };

  useEffect(() => {
    if (!file) return;

    setIsLoading(true);
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const content = e.target?.result as string;
      try {
        const parsed = parseDxf(content, encoding);
        setData(parsed);
        setActiveLayers(new Set(parsed.layers));
        setFilledLayers(new Set());
        
        const colors: LayerColors = {};
        parsed.layers.forEach((layer, index) => {
           let hash = 0;
           for (let i = 0; i < layer.length; i++) {
             hash = layer.charCodeAt(i) + ((hash << 5) - hash);
           }
           const colorIndex = Math.abs(hash) % CAD_COLORS.length;
           colors[layer] = CAD_COLORS[colorIndex];
        });
        setLayerColors(colors);

      } catch (err) {
        console.error(err);
        alert("Failed to parse DXF file. Please check the format or encoding.");
      } finally {
        setIsLoading(false);
      }
    };
    
    reader.onerror = () => {
      setIsLoading(false);
      alert("Error reading file");
    };

    reader.readAsText(file, encoding);
  }, [file, encoding]);

  const toggleLayer = (layer: string) => {
    const newActive = new Set(activeLayers);
    if (newActive.has(layer)) {
      newActive.delete(layer);
    } else {
      newActive.add(layer);
    }
    setActiveLayers(newActive);
  };

  const toggleAllLayers = () => {
    if (!data) return;
    if (activeLayers.size === data.layers.length) {
      setActiveLayers(new Set());
    } else {
      setActiveLayers(new Set(data.layers));
    }
  };

  const filteredLayers = useMemo(() => {
    if (!data) return [];
    if (!layerSearchTerm) return data.layers;
    return data.layers.filter(l => l.toLowerCase().includes(layerSearchTerm.toLowerCase()));
  }, [data, layerSearchTerm]);

  // Recursively extract entities from layers, transforming block coordinates to world space
  const extractEntities = (targetLayers: string[], rootEntities: DxfEntity[], blocks: Record<string, DxfEntity[]>): DxfEntity[] => {
      const extracted: DxfEntity[] = [];
      
      const recurse = (entities: DxfEntity[], transform: Transform) => {
          entities.forEach(ent => {
             // 1. Recursion into Blocks
             if (ent.type === EntityType.INSERT && ent.blockName && blocks[ent.blockName]) {
                 const tScale = { 
                    x: transform.scale.x * (ent.scale?.x || 1), 
                    y: transform.scale.y * (ent.scale?.y || 1) 
                 };
                 const tRotation = transform.rotation + (ent.rotation || 0);
                 const tPos = transformPoint(ent.start || {x:0, y:0}, transform.scale, transform.rotation, transform.translation);
                 
                 recurse(blocks[ent.blockName], {
                    scale: tScale,
                    rotation: tRotation,
                    translation: tPos
                 });
                 return;
             }

             // 2. Collection of Target Entities
             if (targetLayers.includes(ent.layer)) {
                 // Clone and transform geometry to world space
                 const worldEnt = { ...ent };
                 
                 // Apply transform to common geometry points
                 if (worldEnt.start) worldEnt.start = transformPoint(worldEnt.start, transform.scale, transform.rotation, transform.translation);
                 if (worldEnt.end) worldEnt.end = transformPoint(worldEnt.end, transform.scale, transform.rotation, transform.translation);
                 if (worldEnt.center) worldEnt.center = transformPoint(worldEnt.center, transform.scale, transform.rotation, transform.translation);
                 
                 if (worldEnt.vertices) {
                     worldEnt.vertices = worldEnt.vertices.map(v => transformPoint(v, transform.scale, transform.rotation, transform.translation));
                 }
                 
                 // Approximate angle rotation for text/rectangles
                 if (worldEnt.startAngle !== undefined) worldEnt.startAngle += transform.rotation;
                 if (worldEnt.endAngle !== undefined) worldEnt.endAngle += transform.rotation;

                 extracted.push(worldEnt);
             }
          });
      };

      recurse(rootEntities, { scale: {x:1, y:1}, rotation: 0, translation: {x:0, y:0} });
      return extracted;
  };

  const calculateBeams = () => {
    if (!data) return;

    const targetLayers = ['BEAM', 'BEAM_CON'];
    const wallLayer = 'WALL';
    const colLayer = 'COLU';
    
    const resultLayer = 'BEAM_CALC';
    const contextLayers = ['WALL', 'COLU', 'AXIS', 'Z主楼梁筋（横向）', 'Z主楼梁筋（纵向）'];

    const entities = extractEntities(targetLayers, data.entities, data.blocks);
    const obstacles = extractEntities([wallLayer, colLayer], data.entities, data.blocks);

    const newEntities: DxfEntity[] = [];

    // Separate Lines and Polylines
    const lines = entities.filter(e => e.type === EntityType.LINE);
    const polylines = entities.filter(e => e.type === EntityType.LWPOLYLINE && e.closed);

    // 1. Process Parallel Lines (Filling mode)
    // Pass obstacles to allow beams to snap to walls/columns
    const generatedPolygons = findParallelPolygons(lines, 1200, resultLayer, obstacles);
    
    // 2. Process Existing Polylines
    const existingPolygons = polylines.map(p => ({ ...p, layer: resultLayer }));

    const allBeams = [...generatedPolygons, ...existingPolygons];

    allBeams.forEach(ent => {
        const props = getBeamProperties(ent);
        // Only consider beams of significant length (> 500mm)
        if (props.length > 500) {
            newEntities.push(ent); // The geometry itself (filled)

            const center = getCenter(ent);
            if (center) {
                newEntities.push({
                    type: EntityType.TEXT,
                    layer: resultLayer,
                    start: center,
                    text: `L=${Math.round(props.length)}`,
                    radius: 250,
                    startAngle: props.angle % 180 === 0 ? 0 : props.angle
                });
            }
        }
    });

    if (newEntities.length === 0) {
        alert("No calculable beams found.");
        return;
    }

    // Enable filling
    const newFilled = new Set(filledLayers);
    newFilled.add(resultLayer);
    setFilledLayers(newFilled);

    updateDataWithCalculation(resultLayer, newEntities, '#00FF00', contextLayers);
    alert(`Calculated ${allBeams.length} beam segments.`);
  };

  const calculateWalls = () => {
    if (!data) return;
    const targetLayer = 'WALL';
    const resultLayer = 'WALL_CALC';
    const contextLayers = ['AXIS', 'COLU', 'BEAM_CALC'];

    const rawWallEntities = extractEntities([targetLayer], data.entities, data.blocks);
    
    // Use parallel finder for walls (Tolerance ~600mm)
    const walls = findParallelPolygons(rawWallEntities, 600, resultLayer);
    
    const newEntities: DxfEntity[] = [];
    walls.forEach(w => {
        newEntities.push(w);

        const props = getBeamProperties(w);
        const center = getCenter(w);
        if (center) {
            newEntities.push({
                type: EntityType.TEXT,
                layer: resultLayer,
                start: center,
                text: `L=${Math.round(props.length)}`,
                radius: 250,
                startAngle: props.angle % 180 === 0 ? 0 : props.angle
            });
        }
    });

    if (newEntities.length === 0) {
        alert("No parallel wall lines found to calculate.");
        return;
    }

    const newFilled = new Set(filledLayers);
    newFilled.add(resultLayer);
    setFilledLayers(newFilled);

    updateDataWithCalculation(resultLayer, newEntities, '#64748b', contextLayers); 
    alert(`Calculated ${walls.length} wall segments.`);
  };

  const updateDataWithCalculation = (resultLayer: string, newEntities: DxfEntity[], color: string, contextLayers: string[]) => {
      if (!data) return;
      const newData = {
          ...data,
          entities: [...data.entities, ...newEntities],
          layers: data.layers.includes(resultLayer) ? data.layers : [resultLayer, ...data.layers]
      };
      setData(newData);
      setLayerColors(prev => ({ ...prev, [resultLayer]: color }));

      const newActive = new Set(activeLayers);
      newActive.add(resultLayer);
      contextLayers.forEach(l => {
          if (data.layers.includes(l)) newActive.add(l);
      });
      setActiveLayers(newActive);
  };

  const exportPng = () => {
    if (!canvasRef.current || !file) return;
    const link = document.createElement('a');
    link.download = `${file.name.replace('.dxf', '')}_export.png`;
    link.href = canvasRef.current.toDataURL('image/png');
    link.click();
  };

  const exportPdf = () => {
    if (!canvasRef.current || !file) return;
    
    const canvas = canvasRef.current;
    const imgData = canvas.toDataURL('image/png');
    
    const pdf = new jsPDF({
      orientation: canvas.width > canvas.height ? 'l' : 'p',
      unit: 'mm',
    });

    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();
    
    const imgProps = pdf.getImageProperties(imgData);
    const ratio = imgProps.width / imgProps.height;
    
    let w = pdfWidth;
    let h = w / ratio;
    
    if (h > pdfHeight) {
      h = pdfHeight;
      w = h * ratio;
    }

    const x = (pdfWidth - w) / 2;
    const y = (pdfHeight - h) / 2;

    pdf.setFillColor(15, 23, 42); 
    pdf.rect(0, 0, pdfWidth, pdfHeight, 'F');
    pdf.addImage(imgData, 'PNG', x, y, w, h);
    pdf.save(`${file.name.replace('.dxf', '')}_export.pdf`);
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-950 text-slate-100">
      
      {/* Sidebar */}
      <div 
        className={`${
          isSidebarOpen ? 'w-80' : 'w-0'
        } bg-slate-900 border-r border-slate-800 transition-all duration-300 flex flex-col relative shrink-0`}
      >
        <div className="p-4 border-b border-slate-800 flex justify-between items-center">
          <h1 className="font-bold text-xl flex items-center gap-2 text-blue-400">
            <Settings className="w-5 h-5" />
            DXF Vista
          </h1>
          <button onClick={() => setSidebarOpen(false)} className="md:hidden text-slate-400">
            <X size={20} />
          </button>
        </div>

        <div className="p-4 border-b border-slate-800 space-y-4">
           {/* Upload */}
           <label className="block w-full cursor-pointer group">
              <div className="flex flex-col items-center justify-center w-full h-20 border-2 border-slate-700 border-dashed rounded-lg bg-slate-800/50 hover:bg-slate-800 hover:border-blue-500 transition-all">
                  <div className="flex flex-col items-center justify-center pt-1 pb-2">
                      <Upload className="w-5 h-5 mb-1 text-slate-400 group-hover:text-blue-400" />
                      <p className="text-xs text-slate-400 group-hover:text-slate-200 truncate max-w-[200px]">
                        {file ? file.name : "Upload DXF"}
                      </p>
                  </div>
                  <input type="file" accept=".dxf" className="hidden" onChange={handleFileUpload} />
              </div>
           </label>

           {/* Encoding Selector */}
           <div className="flex flex-col gap-2">
              <label className="text-xs text-slate-500 font-medium flex items-center gap-1">
                <Globe size={12} />
                Text Encoding
              </label>
              <select 
                value={encoding} 
                onChange={(e) => setEncoding(e.target.value)}
                className="w-full bg-slate-800 text-xs text-slate-200 border border-slate-700 rounded px-2 py-2 focus:ring-1 focus:ring-blue-500 outline-none"
              >
                {ENCODINGS.map(enc => (
                  <option key={enc.value} value={enc.value}>{enc.label}</option>
                ))}
              </select>
           </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
              <Layers size={14} /> Layers
            </h2>
            {data && (
              <button onClick={toggleAllLayers} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                <RefreshCw size={10} />
                {activeLayers.size === data.layers.length ? 'Hide All' : 'Show All'}
              </button>
            )}
          </div>

          {/* Layer Search */}
          {data && (
            <div className="relative mb-3">
              <input 
                type="text" 
                placeholder="Search layers..." 
                value={layerSearchTerm}
                onChange={(e) => setLayerSearchTerm(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 pl-8 text-xs focus:ring-1 focus:ring-blue-500 outline-none"
              />
              <Search className="absolute left-2.5 top-1.5 text-slate-500 w-3.5 h-3.5" />
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
               <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
            </div>
          ) : !data ? (
            <div className="text-center text-slate-600 text-sm py-8">
              No layers loaded.<br/>Please upload a file.
            </div>
          ) : (
            <div className="space-y-1">
              {filteredLayers.length === 0 && (
                <div className="text-xs text-slate-500 text-center py-4">No layers found</div>
              )}
              {filteredLayers.map((layer) => (
                <div 
                  key={layer} 
                  className={`flex items-center p-2 rounded cursor-pointer transition-colors ${
                    activeLayers.has(layer) ? 'bg-slate-800 text-slate-200' : 'text-slate-500 hover:bg-slate-800/50'
                  }`}
                  onClick={() => toggleLayer(layer)}
                >
                  <div 
                    className="w-3 h-3 rounded-full mr-3 shrink-0" 
                    style={{ 
                      backgroundColor: layerColors[layer],
                      boxShadow: activeLayers.has(layer) ? `0 0 6px ${layerColors[layer]}` : 'none',
                      opacity: activeLayers.has(layer) ? 1 : 0.4
                    }}
                  ></div>
                  <span className="text-sm truncate select-none" title={layer}>{layer}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-800 space-y-3">
            <p className="text-xs text-slate-500 font-medium mb-2">ANALYSIS</p>
            <div className="grid grid-cols-2 gap-2">
                <Button 
                  onClick={calculateBeams} 
                  disabled={!data || isLoading} 
                  variant="primary" 
                  className="w-full justify-center text-xs bg-green-600 hover:bg-green-700"
                  title="Calculate Beams"
                >
                  <Calculator size={14} className="mr-1"/> Beams
                </Button>
                <Button 
                  onClick={calculateWalls} 
                  disabled={!data || isLoading} 
                  variant="primary" 
                  className="w-full justify-center text-xs bg-slate-600 hover:bg-slate-700"
                  title="Calculate Walls"
                >
                  <Boxes size={14} className="mr-1"/> Walls
                </Button>
            </div>

            <div className="h-px bg-slate-800 my-2"></div>
            
            <p className="text-xs text-slate-500 font-medium mb-2">EXPORT</p>
            <Button 
              onClick={exportPdf} 
              disabled={!data || isLoading} 
              variant="secondary" 
              className="w-full justify-start text-sm"
              icon={<FileText size={16} />}
            >
              Export as PDF
            </Button>
            <Button 
              onClick={exportPng} 
              disabled={!data || isLoading} 
              variant="secondary" 
              className="w-full justify-start text-sm"
              icon={<ImageIcon size={16} />}
            >
              Export as PNG
            </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full relative bg-slate-950">
        {!isSidebarOpen && (
          <button 
            onClick={() => setSidebarOpen(true)}
            className="absolute top-4 left-4 z-10 bg-slate-800 p-2 rounded-md shadow-lg text-slate-200 hover:bg-slate-700"
          >
            <Layers size={20} />
          </button>
        )}
        
        <Viewer 
          data={data} 
          activeLayers={activeLayers} 
          layerColors={layerColors}
          filledLayers={filledLayers}
          onRef={(ref) => canvasRef.current = ref} 
        />
        
        {/* Overlay Info */}
        {data && !isLoading && (
           <div className="absolute top-4 right-4 bg-slate-900/90 border border-slate-700 rounded-lg p-3 text-xs text-slate-400 backdrop-blur-sm shadow-xl pointer-events-none">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <span className="font-semibold">Entities:</span>
                <span className="text-right text-slate-200">{data.entities.length}</span>
                <span className="font-semibold">Layers:</span>
                <span className="text-right text-slate-200">{data.layers.length}</span>
                <span className="font-semibold">Visible:</span>
                <span className="text-right text-green-400">{activeLayers.size}</span>
              </div>
           </div>
        )}
      </div>
    </div>
  );
};

export default App;