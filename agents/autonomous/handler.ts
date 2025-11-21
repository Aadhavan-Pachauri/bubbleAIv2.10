
import { GoogleGenAI } from "@google/genai";
import { AgentInput, AgentExecutionResult } from '../types';
import { getUserFriendlyError } from '../errorUtils';
import { generateImage } from '../../services/geminiService';
import { incrementThinkingCount } from '../../services/databaseService';
import { researchService } from "../../services/researchService";
import { BubbleSemanticRouter, RouterAction } from "../../services/semanticRouter";
import { Memory5Layer } from "../../services/memoryService";
import { autonomousInstruction } from './instructions';
import { runCanvasAgent } from "../canvas/handler";

const formatTimestamp = () => {
    return new Date().toLocaleString(undefined, { 
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', 
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' 
    });
};

// Helper for retrying Gemini calls
const generateContentStreamWithRetry = async (
    ai: GoogleGenAI, 
    params: any, 
    retries = 3,
    onRetry?: (msg: string) => void
) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await ai.models.generateContentStream(params);
        } catch (error: any) {
            const isQuotaError = error.status === 429 || 
                                 (error.message && error.message.includes('429')) ||
                                 (error.message && error.message.includes('quota'));
            
            if (isQuotaError && attempt < retries) {
                const delay = Math.pow(2, attempt) * 2000 + 1000; // 3s, 5s, 9s
                console.warn(`Quota limit hit. Retrying in ${delay}ms...`);
                if (onRetry) onRetry(`(Rate limit hit. Retrying in ${Math.round(delay/1000)}s...)`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
    throw new Error("Max retries exceeded");
};

export const runAutonomousAgent = async (input: AgentInput): Promise<AgentExecutionResult> => {
    const { prompt, files, apiKey, project, chat, history, supabase, user, profile, onStreamChunk } = input;
    
    try {
        const ai = new GoogleGenAI({ apiKey });
        const router = new BubbleSemanticRouter(supabase);
        const memory = new Memory5Layer(supabase, user.id);

        // 1. Default Route
        const fileCount = files ? files.length : 0;
        let routing = await router.route(prompt, user.id, apiKey, fileCount);
        
        // 2. Gather Context
        const memoryContext = await memory.getContext([
            'inner_personal', 'outer_personal', 'personal', 
            'interests', 'preferences', 'custom', 
            'codebase', 'aesthetic', 'project'
        ]);
        const dateTimeContext = `[CURRENT DATE & TIME]\n${formatTimestamp()}\n`;
        
        let finalResponseText = '';
        let metadataPayload: any = {};
        
        let currentAction: RouterAction = routing.action;
        let currentPrompt = prompt;
        let loopCount = 0;
        const MAX_LOOPS = 2;

        while (loopCount < MAX_LOOPS) {
            loopCount++;

            switch (currentAction) {
                case 'SEARCH': {
                    onStreamChunk?.("\nSearching the web... 🌐\n");
                    const searchSystemPrompt = `${autonomousInstruction}\n\n${dateTimeContext}\n\nYour task: Provide a helpful, friendly answer to the user's query using Google Search. Maintain your persona (Bubble). Cite sources naturally.`;
                    
                    const searchResponse = await generateContentStreamWithRetry(ai, {
                        model: 'gemini-2.5-flash',
                        contents: `User Query: ${currentPrompt}`,
                        config: {
                            systemInstruction: searchSystemPrompt,
                            tools: [{ googleSearch: {} }],
                        }
                    }, 3, (msg) => onStreamChunk?.(msg));
                    
                    for await (const chunk of searchResponse) {
                        if (chunk.text) {
                            finalResponseText += chunk.text;
                            onStreamChunk?.(chunk.text);
                        }
                        const candidate = chunk.candidates?.[0];
                        if (candidate?.groundingMetadata?.groundingChunks) {
                            if (!metadataPayload.groundingMetadata) metadataPayload.groundingMetadata = [];
                            metadataPayload.groundingMetadata.push(...candidate.groundingMetadata.groundingChunks);
                        }
                    }
                    return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                }

                case 'DEEP_SEARCH': {
                    onStreamChunk?.("\nDeep Researching... 📚\n");
                    const result = await researchService.deepResearch(currentPrompt, (msg) => {
                         onStreamChunk?.(`\n*${msg}*`);
                    });
                    const researchText = result.answer + `\n\n**Sources:**\n${result.sources.join('\n')}`;
                    finalResponseText += "\n\n" + researchText;
                    onStreamChunk?.(researchText);
                    return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                }

                case 'THINK': {
                    onStreamChunk?.("\nThinking deeply... 🧠\n");
                    await incrementThinkingCount(supabase, user.id);
                    
                    const geminiHistory = history.map(msg => ({
                        role: msg.sender === 'user' ? 'user' : 'model' as 'user' | 'model',
                        parts: [{ text: msg.text }],
                    })).filter(msg => msg.parts[0].text.trim() !== '');
                    
                    const contextBlock = `${autonomousInstruction}\n\n${dateTimeContext}\n\n[MEMORY]\n${JSON.stringify(memoryContext)}\n\n[TASK]\n${currentPrompt}`;
                    const contents = [...geminiHistory, { role: 'user', parts: [{ text: contextBlock }] }];

                    // Using a model that supports Thinking Config
                    const response = await generateContentStreamWithRetry(ai, {
                        model: 'gemini-2.5-flash', 
                        contents,
                        config: {
                            // Enable explicit thinking budget
                            thinkingConfig: { thinkingBudget: 2048 },
                        }
                    }, 3, (msg) => onStreamChunk?.(msg));

                    for await (const chunk of response) {
                        if (chunk.text) {
                            finalResponseText += chunk.text;
                            onStreamChunk?.(chunk.text);
                        }
                    }
                    return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                }

                case 'IMAGE': {
                    // Send a JSON event first to trigger UI loader
                    onStreamChunk?.(JSON.stringify({ type: 'image_generation_start', text: finalResponseText }));
                    
                    const imagePrompt = routing.parameters?.prompt || currentPrompt;
                    try {
                        const { imageBase64 } = await generateImage(imagePrompt, apiKey, profile?.preferred_image_model);
                        return { 
                            messages: [{ 
                                project_id: project.id, 
                                chat_id: chat.id, 
                                sender: 'ai', 
                                text: finalResponseText,
                                image_base64: imageBase64, 
                                ...metadataPayload 
                            }] 
                        };
                    } catch (e) {
                        const errorMsg = `\n\n(Image generation failed: ${e instanceof Error ? e.message : 'Unknown error'})`;
                        finalResponseText += errorMsg;
                        onStreamChunk?.(errorMsg);
                        return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                    }
                }

                case 'CANVAS': {
                    // Directly hand off to the Canvas Agent without a conversational intro to reduce noise.
                    const canvasResult = await runCanvasAgent({
                        ...input,
                        prompt: currentPrompt
                    });
                    
                    const canvasMessage = canvasResult.messages[0];
                    finalResponseText = canvasMessage.text || "";
                    
                    return { messages: [{ 
                        project_id: project.id, 
                        chat_id: chat.id, 
                        sender: 'ai', 
                        text: finalResponseText, 
                        ...metadataPayload 
                    }] };
                }

                case 'PROJECT': {
                    onStreamChunk?.("\nBuilding project structure... 🏗️\n");
                     const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: `Build a complete file structure for a project: ${currentPrompt}. Return a JSON object with filenames and brief content descriptions.`,
                        config: { responseMimeType: 'application/json' }
                    });
                    
                    const projectMsg = `\nI've designed the project structure based on your request.\n\n${response.text}\n\n(Switch to Co-Creator mode to fully hydrate and edit these files.)`;
                    finalResponseText += projectMsg;
                    onStreamChunk?.(projectMsg);
                    return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                }
                
                case 'STUDY': {
                    onStreamChunk?.("\nCreating study plan... 🎓\n");
                    const response = await generateContentStreamWithRetry(ai, {
                        model: 'gemini-2.5-flash',
                        contents: `Create a structured study plan for: ${currentPrompt}. Include learning objectives and key concepts.`,
                    }, 3, (msg) => onStreamChunk?.(msg));
                    
                    for await (const chunk of response) {
                        if (chunk.text) {
                            finalResponseText += chunk.text;
                            onStreamChunk?.(chunk.text);
                        }
                    }
                    return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                }

                case 'SIMPLE':
                default: {
                    const systemPrompt = `${autonomousInstruction}\n\n[MEMORY]\n${JSON.stringify(memoryContext)}\n\n${dateTimeContext}`;
                    const geminiHistory = history.map(msg => ({
                        role: msg.sender === 'user' ? 'user' : 'model' as 'user' | 'model',
                        parts: [{ text: msg.text }],
                    })).filter(msg => msg.parts[0].text.trim() !== '');

                    const userParts: any[] = [{ text: currentPrompt }];
                    if (files && files.length > 0) {
                        for (const file of files) {
                            const base64EncodedData = await new Promise<string>((resolve, reject) => {
                                const reader = new FileReader();
                                reader.onload = () => resolve((reader.result as string).split(',')[1]);
                                reader.onerror = reject;
                                reader.readAsDataURL(file);
                            });
                            userParts.unshift({ inlineData: { data: base64EncodedData, mimeType: file.type } });
                        }
                    }
                    const contents = [...geminiHistory, { role: 'user', parts: userParts }];

                    const response = await generateContentStreamWithRetry(ai, {
                        model: 'gemini-2.5-flash',
                        contents,
                        config: { systemInstruction: systemPrompt }
                    }, 3, (msg) => onStreamChunk?.(msg));

                    let generatedThisLoop = "";

                    for await (const chunk of response) {
                        if (chunk.text) {
                            generatedThisLoop += chunk.text;
                            finalResponseText += chunk.text;
                            onStreamChunk?.(chunk.text);
                            
                            const candidate = chunk.candidates?.[0];
                            if (candidate?.groundingMetadata?.groundingChunks) {
                                if (!metadataPayload.groundingMetadata) metadataPayload.groundingMetadata = [];
                                metadataPayload.groundingMetadata.push(...candidate.groundingMetadata.groundingChunks);
                            }
                        }
                    }
                    
                    // Regex tag detection for router handover
                    const searchMatch = generatedThisLoop.match(/<SEARCH>(.*?)<\/SEARCH>/);
                    const deepMatch = generatedThisLoop.match(/<DEEP>(.*?)<\/DEEP>/) || generatedThisLoop.match(/<SEARCH>deep\s+(.*?)<\/SEARCH>/i);
                    const thinkMatch = generatedThisLoop.match(/<THINK>(.*?)<\/THINK>/) || generatedThisLoop.match(/<THINK>/);
                    const imageMatch = generatedThisLoop.match(/<IMAGE>(.*?)<\/IMAGE>/);
                    const projectMatch = generatedThisLoop.match(/<PROJECT>(.*?)<\/PROJECT>/);
                    const canvasMatch = generatedThisLoop.match(/<CANVAS>(.*?)<\/CANVAS>/);
                    const studyMatch = generatedThisLoop.match(/<STUDY>(.*?)<\/STUDY>/);

                    if (deepMatch) { currentAction = 'DEEP_SEARCH'; currentPrompt = deepMatch[1]; continue; }
                    if (searchMatch) { currentAction = 'SEARCH'; currentPrompt = searchMatch[1]; continue; }
                    if (thinkMatch) { currentAction = 'THINK'; currentPrompt = thinkMatch[1] ? thinkMatch[1].trim() : prompt; continue; }
                    if (imageMatch) { currentAction = 'IMAGE'; currentPrompt = imageMatch[1]; routing.parameters = { prompt: imageMatch[1] }; continue; }
                    if (projectMatch) { currentAction = 'PROJECT'; currentPrompt = projectMatch[1]; continue; }
                    if (canvasMatch) { currentAction = 'CANVAS'; currentPrompt = canvasMatch[1]; continue; }
                    if (studyMatch) { currentAction = 'STUDY'; currentPrompt = studyMatch[1]; continue; }
                    
                    return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };
                }
            }
        }
        
        return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: finalResponseText, ...metadataPayload }] };

    } catch (error) {
        console.error("Error in runAutonomousAgent:", error);
        const errorMessage = getUserFriendlyError(error);
        return { messages: [{ project_id: project.id, chat_id: chat.id, sender: 'ai', text: `An error occurred: ${errorMessage}` }] };
    }
};
