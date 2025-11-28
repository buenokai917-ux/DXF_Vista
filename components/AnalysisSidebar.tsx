
import React from 'react';
import { ProjectFile, AnalysisDomain } from '../types';
import { StructurePanel } from './analysis/StructurePanel';
import { LandscapePanel } from './analysis/LandscapePanel';
import { ElectricalPanel } from './analysis/ElectricalPanel';
import { Hammer, Trees, Zap } from 'lucide-react';

interface AnalysisSidebarProps {
    activeProject: ProjectFile | null;
    projects: ProjectFile[];
    isLoading: boolean;
    analysisDomain: AnalysisDomain;
    setAnalysisDomain: (domain: AnalysisDomain) => void;
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>;
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

export const AnalysisSidebar: React.FC<AnalysisSidebarProps> = ({
    activeProject,
    projects,
    isLoading,
    analysisDomain,
    setAnalysisDomain,
    setProjects,
    setLayerColors
}) => {
    
    return (
        <div className="p-4 border-b border-slate-800 flex flex-col gap-3">
             {/* Domain Switcher as Tabs */}
             <div className="flex bg-slate-800 rounded p-1">
                <button
                    onClick={() => setAnalysisDomain('STRUCTURE')}
                    className={`flex-1 flex items-center justify-center py-1.5 rounded text-[10px] font-medium transition-colors ${
                        analysisDomain === 'STRUCTURE' ? 'bg-slate-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                    }`}
                >
                   <Hammer size={12} className="mr-1.5"/> Structure
                </button>
                <button
                    onClick={() => setAnalysisDomain('LANDSCAPE')}
                    className={`flex-1 flex items-center justify-center py-1.5 rounded text-[10px] font-medium transition-colors ${
                        analysisDomain === 'LANDSCAPE' ? 'bg-slate-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                    }`}
                >
                   <Trees size={12} className="mr-1.5"/> Landscape
                </button>
                <button
                    onClick={() => setAnalysisDomain('ELECTRICAL')}
                    className={`flex-1 flex items-center justify-center py-1.5 rounded text-[10px] font-medium transition-colors ${
                        analysisDomain === 'ELECTRICAL' ? 'bg-slate-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                    }`}
                >
                   <Zap size={12} className="mr-1.5"/> Electrical
                </button>
             </div>

            {/* Content Area */}
            {analysisDomain === 'STRUCTURE' && (
                <StructurePanel 
                    activeProject={activeProject}
                    projects={projects}
                    isLoading={isLoading}
                    setProjects={setProjects}
                    setLayerColors={setLayerColors}
                />
            )}
            
            {analysisDomain === 'LANDSCAPE' && <LandscapePanel />}
            
            {analysisDomain === 'ELECTRICAL' && <ElectricalPanel />}
        </div>
    );
};
