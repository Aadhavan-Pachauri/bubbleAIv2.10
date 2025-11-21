
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SparklesIcon, ChevronDownIcon } from '@heroicons/react/24/outline';

interface CanvasThinkingDisplayProps {
    thinking: string;
    isTyping?: boolean;
}

export const CanvasThinkingDisplay: React.FC<CanvasThinkingDisplayProps> = ({ thinking, isTyping }) => {
    const [isOpen, setIsOpen] = useState(true);
    const isBuffering = thinking === '';

    // Auto-expand if typing
    React.useEffect(() => {
        if (isTyping) setIsOpen(true);
    }, [isTyping]);

    return (
        <div className="mb-4 border-l-2 border-gray-700 pl-3">
             <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 text-xs font-medium text-gray-400 hover:text-primary-start transition-colors py-1"
            >
                <div className={`flex items-center justify-center w-4 h-4 rounded bg-white/5 ${isTyping && isBuffering ? 'animate-pulse' : ''}`}>
                    <SparklesIcon className="w-3 h-3 text-gray-400" />
                </div>
                <span className="flex-1">{isTyping && isBuffering ? 'Reasoning...' : 'Thought Process'}</span>
                <ChevronDownIcon className={`w-3 h-3 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
            </button>
            <AnimatePresence>
                {isOpen && (
                    <motion.div 
                        initial={{ opacity: 0, height: 0 }} 
                        animate={{ opacity: 1, height: 'auto' }} 
                        exit={{ opacity: 0, height: 0 }} 
                        className="overflow-hidden"
                    >
                        <div className="mt-1 text-xs text-gray-400 font-mono whitespace-pre-wrap leading-relaxed bg-black/10 p-2 rounded-md max-h-60 overflow-y-auto">
                            {isBuffering ? (
                                <span className="animate-pulse">Analyzing request...</span>
                            ) : thinking}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
