
import React from 'react';
import { ProjectFile, SemanticLayer } from '../../types';
import { Target, Check, Trash2, Eye } from 'lucide-react';

interface LayerConfigPanelProps {
    activeProject: ProjectFile;
    pickingTarget: SemanticLayer | null;
    setPickingTarget: (target: SemanticLayer | null) => void;
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>;
}

export const LayerConfigPanel: React.FC<LayerConfigPanelProps> = ({
    activeProject,
    pickingTarget,
    setPickingTarget,
    setProjects
}) => {

    const rows = [
        { key: SemanticLayer.AXIS, label: 'Axis Layer' },
        { key: SemanticLayer.COLUMN, label: 'Column Layer' },
        { key: SemanticLayer.WALL, label: 'Wall Layer' },
        { key: SemanticLayer.BEAM, label: 'Beam Layer' },
        { key: SemanticLayer.BEAM_LABEL, label: 'Beam Label' },
        { key: SemanticLayer.BEAM_IN_SITU_LABEL, label: 'In-situ Annotation' },
        { key: SemanticLayer.VIEWPORT_TITLE, label: 'View Title' },
    ];

    const removeLayer = (semantic: SemanticLayer, layerName: string) => {
        setProjects(prev => prev.map(p => {
            if (p.id !== activeProject.id) return p;
            const current = p.layerConfig[semantic] || [];
            return {
                ...p,
                layerConfig: {
                    ...p.layerConfig,
                    [semantic]: current.filter(l => l !== layerName)
                }
            };
        }));
    };

    const clearAllLayers = (semantic: SemanticLayer) => {
        setProjects(prev => prev.map(p => {
            if (p.id !== activeProject.id) return p;
            return {
                ...p,
                layerConfig: {
                    ...p.layerConfig,
                    [semantic]: []
                }
            };
        }));
    };

    const isolateLayer = (layerName: string) => {
        setProjects(prev => prev.map(p => {
            if (p.id !== activeProject.id) return p;
            return {
                ...p,
                activeLayers: new Set([layerName])
            };
        }));
    };

    const showAllLayers = () => {
        setProjects(prev => prev.map(p => {
            if (p.id !== activeProject.id) return p;
            return {
                ...p,
                activeLayers: new Set(p.data.layers)
            };
        }));
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider flex items-center">
                    <span className="w-4 h-4 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center mr-2 text-[9px]">0</span>
                    Layer Configuration
                </h3>
                <button 
                    onClick={showAllLayers}
                    className="text-[9px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
                >
                    <Eye size={10} /> Show All Layers
                </button>
            </div>
            
            <div className="bg-slate-900/50 rounded-lg p-2 space-y-2 border border-slate-800">
                {rows.map(row => {
                    const layers = activeProject.layerConfig[row.key] || [];
                    const isPicking = pickingTarget === row.key;

                    return (
                        <div key={row.key} className="flex flex-col gap-1">
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] text-slate-400 font-medium">{row.label}</span>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => clearAllLayers(row.key)}
                                        className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-slate-800 transition-colors"
                                        title="Clear all"
                                        disabled={layers.length === 0}
                                    >
                                        <Trash2 size={10} />
                                    </button>
                                    <button
                                        onClick={() => setPickingTarget(isPicking ? null : row.key)}
                                        className={`p-1 rounded transition-colors flex items-center gap-1 text-[10px] font-medium border ${
                                            isPicking 
                                            ? 'bg-blue-600 border-blue-500 text-white animate-pulse' 
                                            : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white hover:border-slate-600'
                                        }`}
                                    >
                                        {isPicking ? <Check size={10} /> : <Target size={10} />}
                                        {isPicking ? 'Done' : 'Pick'}
                                    </button>
                                </div>
                            </div>
                            
                            {/* Selected Layers List */}
                            <div className="flex flex-wrap gap-1 min-h-[20px] bg-slate-950/50 rounded p-1 border border-slate-800/50">
                                {layers.length === 0 ? (
                                    <span className="text-[9px] text-slate-600 italic px-1">None selected</span>
                                ) : (
                                    layers.map(l => (
                                        <div 
                                            key={l} 
                                            className="flex items-center bg-slate-800 text-slate-300 text-[9px] px-1.5 py-0.5 rounded border border-slate-700 group cursor-pointer hover:bg-slate-700 hover:border-slate-500 transition-colors"
                                            onClick={() => isolateLayer(l)}
                                            title="Click to isolate layer"
                                        >
                                            <span className="max-w-[80px] truncate">{l}</span>
                                            <button 
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    removeLayer(row.key, l);
                                                }}
                                                className="ml-1 text-slate-500 hover:text-red-400 hidden group-hover:block"
                                            >
                                                <Trash2 size={8} />
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};