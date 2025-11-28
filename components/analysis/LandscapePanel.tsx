
import React from 'react';
import { Trees } from 'lucide-react';

export const LandscapePanel: React.FC = () => {
    return (
        <div className="flex flex-col items-center justify-center py-4 text-slate-500 space-y-2 border-2 border-dashed border-slate-800 rounded animate-in fade-in">
            <Trees size={24} />
            <span className="text-xs">Landscape Tools Coming Soon</span>
        </div>
    );
};
