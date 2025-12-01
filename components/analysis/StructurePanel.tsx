import React from 'react';
import { ProjectFile } from '../../types';
import { runCalculateSplitRegions, runMergeViews } from '../../domains/structure-views';
import { runCalculateColumns, runCalculateWalls } from '../../domains/structure-verticals';
import { runBeamRawGeneration, runBeamIntersectionProcessing, runBeamAttributeMounting, runBeamTopologyMerge, runBeamPropagation } from '../../domains/structure-beams';
import { Button } from '../Button';
import { Grid, Merge, Box, ArrowRightLeft, AlignJustify, Tag, GitMerge, Radio, Spline } from 'lucide-react';

interface StructurePanelProps {
    activeProject: ProjectFile | null;
    projects: ProjectFile[];
    isLoading: boolean;
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>;
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

export const StructurePanel: React.FC<StructurePanelProps> = ({
    activeProject,
    projects,
    isLoading,
    setProjects,
    setLayerColors
}) => {
    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-left-2 duration-300">
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
                        onClick={() => activeProject && runBeamPropagation(activeProject, projects, setProjects, setLayerColors)}
                        disabled={!activeProject || isLoading} 
                        variant="secondary" 
                        className="w-full text-xs py-1.5 justify-start pl-3"
                        icon={<Radio size={12} className="text-pink-500"/>}
                    >
                        Step 5: Propagation
                    </Button>
                </div>
            </div>
        </div>
    );
};