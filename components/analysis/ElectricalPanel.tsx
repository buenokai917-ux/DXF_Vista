
import React from 'react';
import { Zap } from 'lucide-react';

export const ElectricalPanel: React.FC = () => {
    return (
        <div className="flex flex-col items-center justify-center py-4 text-slate-500 space-y-2 border-2 border-dashed border-slate-800 rounded animate-in fade-in">
            <Zap size={24} />
            <span className="text-xs">Electrical Tools Coming Soon</span>
        </div>
    );
};
