
import React, { useRef } from 'react';
import { ProjectFile, SemanticLayer } from '../../types';
import { runCalculateSplitRegions, runMergeViews } from '../../domains/structure/views';
import { exportAnalysisState, importAnalysisState } from '../../domains/structure/analysisPersistence';
import { runCalculateColumns, runCalculateWalls } from '../../domains/structure/verticals';
import { 
    runBeamRawGeneration, 
    runBeamIntersectionProcessing, 
    runBeamAttributeMounting, 
    runBeamTopologyMerge, 
    runBeamCalculation 
} from '../../domains/structure/beams/index';
import { Button } from '../Button';
import { Grid, Merge, Box, ArrowRightLeft, AlignJustify, Tag, GitMerge, Spline, Calculator } from 'lucide-react';
import { LayerConfigPanel } from './LayerConfigPanel';

interface StructurePanelProps {
    activeProject: ProjectFile | null;
    projects: ProjectFile[];
    isLoading: boolean;
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>;
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    pickingTarget: SemanticLayer | null;
    setPickingTarget: (target: SemanticLayer | null) => void;
}

export const StructurePanel: React.FC<StructurePanelProps> = ({
    activeProject,
    projects,
    isLoading,
    setProjects,
    setLayerColors,
    pickingTarget,
    setPickingTarget
}) => {
    const importInputRef = useRef<HTMLInputElement | null>(null);

    const handleImportAnalysis = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !activeProject) return;
        importAnalysisState(file, activeProject, setProjects, setLayerColors);
        e.target.value = '';
    };

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-left-2 duration-300">
            {/* Step 0: Layer Config */}
            {activeProject && (
                <LayerConfigPanel 
                    activeProject={activeProject}
                    pickingTarget={pickingTarget}
                    setPickingTarget={setPickingTarget}
                    setProjects={setProjects}
                />
            )}

            {/* Step 1: View Setup */}
            <div className="space-y-2">
                <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider flex items-center">
                    <span className="w-4 h-4 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center mr-2 text-[9px]">1</span>
                    View Setup
                </h3>
                <div className="grid grid-cols-2 gap-2">
                    <Button 
                        onClick={() => activeProject && runCalculateSplitRegions(activeProject, setProjects, setLayerColors)}
                        disabled={!activeProject || isLoading} 
                        variant="secondary" 
                        className="w-full text-xs py-1.5"
                        icon={<Grid size={12}/>}
                    >
                        Split Views
                    </Button>
                    <Button 
                        onClick={() => activeProject && runMergeViews(activeProject, setProjects, setLayerColors)}
                        disabled={!activeProject || isLoading} 
                        variant="secondary" 
                        className="w-full text-xs py-1.5"
                        icon={<Merge size={12}/>}
                    >
                        Merge Views
                    </Button>
                    <Button 
                        onClick={() => activeProject && exportAnalysisState(activeProject)}
                        disabled={!activeProject || isLoading || !activeProject.splitRegions}
                        variant="secondary"
                        className="w-full text-xs py-1.5"
                        icon={<ArrowRightLeft size={12} className="text-blue-400" />}
                    >
                        Export Analysis
                    </Button>
                    <div className="relative">
                        <input
                            ref={importInputRef}
                            type="file"
                            accept="application/json"
                            className="hidden"
                            onChange={handleImportAnalysis}
                        />
                        <Button
                            onClick={() => importInputRef.current?.click()}
                            disabled={!activeProject || isLoading}
                            variant="secondary"
                            className="w-full text-xs py-1.5"
                            icon={<ArrowRightLeft size={12} className="rotate-180 text-emerald-400" />}
                        >
                        Import Analysis
                        </Button>
                    </div>
                </div>
            </div>

            {/* Step 2: Vertical Elements */}
            <div className="space-y-2">
                <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider flex items-center">
                    <span className="w-4 h-4 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center mr-2 text-[9px]">2</span>
                    Vertical Elements
                </h3>
                <div className="grid grid-cols-2 gap-2">
                    <Button 
                        onClick={() => activeProject && runCalculateColumns(activeProject, projects, setProjects, setLayerColors)}
                        disabled={!activeProject || isLoading} 
                        variant="secondary" 
                        className="w-full text-xs py-1.5"
                        icon={<Box size={12}/>}
                    >
                        Columns
                    </Button>
                    <Button 
                        onClick={() => activeProject && runCalculateWalls(activeProject, projects, setProjects, setLayerColors)}
                        disabled={!activeProject || isLoading} 
                        variant="secondary" 
                        className="w-full text-xs py-1.5"
                        icon={<AlignJustify size={12} className="rotate-90"/>}
                    >
                        Walls
                    </Button>
                </div>
            </div>

            {/* Step 3: Horizontal Elements (Pipeline) */}
            <div className="space-y-2">
                <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider flex items-center">
                    <span className="w-4 h-4 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center mr-2 text-[9px]">3</span>
                    Beam Pipeline
                </h3>
                <div className="flex flex-col gap-2">
                    <Button 
                        onClick={() => activeProject && runBeamRawGeneration(activeProject, projects, setProjects, setLayerColors)}
                        disabled={!activeProject || isLoading} 
                        variant="secondary" 
                        className="w-full text-xs py-1.5 justify-start pl-3"
                        icon={<Spline size={12} className="text-green-500"/>}
                    >
                        Step 1: Raw Generation
                    </Button>
                    <Button 
                        onClick={() => activeProject && runBeamIntersectionProcessing(activeProject, projects, setProjects, setLayerColors)}
                        disabled={!activeProject || isLoading} 
                        variant="secondary" 
                        className="w-full text-xs py-1.5 justify-start pl-3"
                        icon={<ArrowRightLeft size={12} className="text-cyan-500"/>}
                    >
                        Step 2: Intersection Processing
                    </Button>
                    <Button 
                        onClick={() => activeProject && runBeamAttributeMounting(activeProject, projects, setProjects, setLayerColors)}
                        disabled={!activeProject || isLoading} 
                        variant="secondary" 
                        className="w-full text-xs py-1.5 justify-start pl-3"
                        icon={<Tag size={12} className="text-amber-500"/>}
                    >
                        Step 3: Mount Attributes
                    </Button>
                    <Button 
                        onClick={() => activeProject && runBeamTopologyMerge(activeProject, projects, setProjects, setLayerColors)}
                        disabled={!activeProject || isLoading} 
                        variant="secondary" 
                        className="w-full text-xs py-1.5 justify-start pl-3"
                        icon={<GitMerge size={12} className="text-violet-500"/>}
                    >
                        Step 4: Topology Merge
                    </Button>
                    <Button 
                        onClick={() => activeProject && runBeamCalculation(activeProject, projects, setProjects, setLayerColors)}
                        disabled={!activeProject || isLoading} 
                        variant="secondary" 
                        className="w-full text-xs py-1.5 justify-start pl-3"
                        icon={<Calculator size={12} className="text-pink-500"/>}
                    >
                        Step 5: Calculate & Export PDF
                    </Button>
                </div>
            </div>
        </div>
    );
};
