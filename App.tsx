import React, { useState, useRef, useEffect, useMemo } from 'react';
import { jsPDF } from 'jspdf';
import { parseDxf } from './utils/dxfParser';
import { DxfData, LayerColors } from './types';
import { Viewer } from './components/Viewer';
import { Button } from './components/Button';
import { Upload, Layers, Download, Image as ImageIcon, FileText, Settings, X, RefreshCw, Globe, Search } from 'lucide-react';

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

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState<string>('utf-8');
  const [data, setData] = useState<DxfData | null>(null);
  const [activeLayers, setActiveLayers] = useState<Set<string>>(new Set());
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
        const parsed = parseDxf(content);
        setData(parsed);
        setActiveLayers(new Set(parsed.layers));
        
        // Generate consistent colors for layers
        const colors: LayerColors = {};
        parsed.layers.forEach((layer, index) => {
           // Use a hash of the name to pick a stable color from the palette, or just cycle
           // Hashing ensures the same layer name always gets the same color across reloads
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

    pdf.setFillColor(15, 23, 42); // Match bg color
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