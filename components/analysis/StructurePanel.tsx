
import React from 'react';
import { Button } from '../Button';
import { ProjectFile } from '../../types';
import { Grid, GitMerge, Square, Box, Calculator } from 'lucide-react';
import { runCalculateSplitRegions, runMergeViews, runCalculateColumns, runCalculateWalls, runCalculateBeams } from '../../domains/structure';

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
        <div className="space-y-3 animate-in fade-in slide-in-from-left-4 duration-300">
            <div className="space-y-1">
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider ml-1">1. View Setup</p>
                <div className="grid grid-cols-2 gap-2">
                     <Button 
                        onClick={() => activeProject && runCalculateSplitRegions(activeProject, setProjects, setLayerColors)} 
                        disabled={!activeProject || isLoading} 
                        variant="primary" 
                        className="w-full justify-center text-xs bg-purple-600 hover:bg-purple-700"
                        title="Split View / Identify Blocks"
                      >
                        <Grid size={14} className="mr-1"/> Split
                      </Button>
                      <Button 
                        onClick={() => activeProject && runMergeViews(activeProject, setProjects, setLayerColors)} 
                        disabled={!activeProject || isLoading} 
                        variant="primary" 
                        className="w-full justify-center text-xs bg-indigo-600 hover:bg-indigo-700"
                        title="Merge Split Views"
                      >
                        <GitMerge size={14} className="mr-1"/> Merge
                      </Button>
                </div>
            </div>

            <div className="space-y-1">
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider ml-1">2. Vertical Elements</p>
                <div className="grid grid-cols-2 gap-2">
                     <Button 
                        onClick={() => activeProject && runCalculateColumns(activeProject, projects, setProjects, setLayerColors)} 
                        disabled={!activeProject || isLoading} 
                        variant="primary" 
                        className="w-full justify-center text-xs bg-amber-600 hover:bg-amber-700"
                      >
                        <Square size={14} className="mr-1"/> Columns
                      </Button>
                      <Button 
                        onClick={() => activeProject && runCalculateWalls(activeProject, projects, setProjects, setLayerColors)} 
                        disabled={!activeProject || isLoading} 
                        variant="primary" 
                        className="w-full justify-center text-xs bg-slate-600 hover:bg-slate-700"
                      >
                        <Box size={14} className="mr-1"/> Walls
                      </Button>
                </div>
            </div>

            <div className="space-y-1">
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider ml-1">3. Horizontal Elements</p>
                 <Button 
                    onClick={() => activeProject && runCalculateBeams(activeProject, projects, setProjects, setLayerColors)} 
                    disabled={!activeProject || isLoading} 
                    variant="primary" 
                    className="w-full justify-center text-xs bg-green-600 hover:bg-green-700"
                  >
                    <Calculator size={14} className="mr-1"/> Calculate Beams
                  </Button>
            </div>
        </div>
    );
};
