
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from './useToast';
import { Project, Message, Chat, WorkspaceMode, ChatWithProjectData } from '../types';
import { 
    getAllChatsForUser, 
    addMessage, 
    updateDbChat, 
    getMessages, 
    deleteChat, 
    updateMessagePlan,
    getChatsForProject,
} from '../services/databaseService';
import { runAgent } from '../agents';
import { User } from '@supabase/supabase-js';
import { AgentExecutionResult } from '../agents/types';

const DUMMY_AUTONOMOUS_PROJECT: Project = {
  id: 'autonomous-project',
  user_id: 'unknown',
  name: 'Autonomous Chat',
  description: 'A personal chat with the AI.',
  status: 'In Progress',
  platform: 'Web App',
  project_type: 'conversation',
  default_model: 'gemini-2.5-flash',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

interface UseChatProps {
    user: User | null;
    geminiApiKey: string | null;
    workspaceMode: WorkspaceMode;
    adminProject?: Project | null; 
}

const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = error => reject(error);
    });
};

export const useChat = ({ user, geminiApiKey, workspaceMode, adminProject }: UseChatProps) => {
    const { supabase, profile } = useAuth();
    const { addToast } = useToast();

    const [allChats, setAllChats] = useState<ChatWithProjectData[]>([]);
    const [activeChat, setActiveChat] = useState<ChatWithProjectData | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isCreatingChat, setIsCreatingChat] = useState(false);
    
    const isSendingRef = useRef(false);
    const activeChatIdRef = useRef<string | null>(null);

    useEffect(() => {
        activeChatIdRef.current = activeChat?.id || null;
    }, [activeChat]);

    const activeProject = useMemo(() => adminProject ?? activeChat?.projects ?? null, [adminProject, activeChat]);
    
    // Fetch chats
    useEffect(() => {
        if (!supabase || !user) return;
        const fetchChats = async () => {
            setIsLoading(true);
            try {
                let chats: ChatWithProjectData[] = [];
                if (adminProject) {
                    const projectChats = await getChatsForProject(supabase, adminProject.id);
                    chats = projectChats.map(c => ({...c, projects: adminProject }));
                } else if(user) {
                    chats = await getAllChatsForUser(supabase, user.id);
                }
                setAllChats(chats);
            } catch (error) {
                console.error("Error fetching chats:", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchChats();
    }, [user, supabase, addToast, adminProject]);

    // Fetch messages with smart merging
    useEffect(() => {
        const fetchMessages = async () => {
            if (activeChat && supabase) {
                const chatId = activeChat.id;
                // Don't show loading spinner if we are just sending a message, to prevent UI flicker
                if (!isSendingRef.current) setIsLoading(true);
                
                try {
                    const history = await getMessages(supabase, chatId);
                    
                    if (activeChatIdRef.current === chatId) {
                        setMessages(prev => {
                            // 1. Identify optimistic messages (temp IDs) currently in state
                            const pendingOptimistic = prev.filter(p => p.id.startsWith('temp-'));
                            
                            // 2. Strategy: Use authoritative DB history, but re-attach any pending optimistic messages
                            // that haven't been confirmed yet.
                            if (pendingOptimistic.length > 0) {
                                // Filter out optimistic messages that look like they've been replaced by DB messages
                                // (e.g. matching text and sender)
                                const remainingOptimistic = pendingOptimistic.filter(opt => 
                                    !history.some(dbMsg => dbMsg.text === opt.text && dbMsg.sender === opt.sender)
                                );
                                return [...history, ...remainingOptimistic];
                            }
                            return history;
                        });
                    }
                } catch (error) { 
                    console.error("Error fetching messages:", error);
                } 
                finally { setIsLoading(false); }
            } else {
                setMessages([]);
            }
        };
        fetchMessages();
        
        // Set up realtime subscription
        if (activeChat && supabase) {
            const channel = supabase.channel(`chat:${activeChat.id}`)
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${activeChat.id}` }, (payload) => {
                    // Only process external inserts (not our own, handled by handleSendMessage optimistic update mostly)
                    // However, to be safe and consistent, we just fetch/merge.
                    // Or we can merge specifically here:
                    const newMsg = payload.new as Message;
                    setMessages(prev => {
                        // Avoid duplicates
                        if (prev.some(m => m.id === newMsg.id)) return prev;
                        
                        // Try to find if this is the permanent version of a temp message
                        // Naive check: same text and sender
                        const filtered = prev.filter(m => {
                            if (!m.id.startsWith('temp-')) return true;
                            return !(m.text === newMsg.text && m.sender === newMsg.sender);
                        });
                        return [...filtered, newMsg];
                    });
                })
                .subscribe();
                
            return () => { supabase.removeChannel(channel); };
        }
    }, [activeChat, supabase]);

    const handleSelectChat = useCallback((chat: ChatWithProjectData) => {
        setActiveChat(chat);
    }, []);

    const handleUpdateChat = useCallback(async (chatId: string, updates: Partial<Chat>) => {
        if (!supabase) return;
        try {
            // @ts-ignore
            const updatedChat = await updateDbChat(supabase, chatId, updates);
            // @ts-ignore
            setAllChats(prev => prev.map(c => c.id === chatId ? { ...c, ...updatedChat } : c));
            // @ts-ignore
            setActiveChat(prev => (prev?.id === chatId ? { ...prev, ...updatedChat } : prev));
        } catch (error) { 
             console.error("Failed to update chat:", error);
        }
    }, [supabase]);

    const handleDeleteChat = async (chatId: string) => {
        if (!supabase) return;
        try {
            await deleteChat(supabase, chatId);
            setAllChats(prev => prev.filter(c => c.id !== chatId));
            if (activeChat?.id === chatId) setActiveChat(null);
            addToast('Chat deleted.', 'info');
        } catch (error) {
            addToast('Failed to delete chat.', 'error');
        }
    };
    
    const handleSendMessage = useCallback(async (text: string, files: File[] | null = null, chatToUse: ChatWithProjectData | null = activeChat): Promise<AgentExecutionResult> => {
      if ((!text.trim() && (!files || files.length === 0)) || !supabase || !user || !chatToUse || !geminiApiKey) return { messages: [] };
      
      if (isSendingRef.current) return { messages: [] };
      isSendingRef.current = true;

      const tempId = `temp-ai-${Date.now()}`;
      const tempUserMsgId = `temp-user-${Date.now()}`;
      let currentText = '';

      try {
        const userMessageData: Omit<Message, 'id' | 'created_at'> = {
          project_id: chatToUse.project_id,
          chat_id: chatToUse.id,
          // @ts-ignore
          user_id: user.id, text, sender: 'user',
        };

        if (files && files.length > 0) {
            const base64Strings = await Promise.all(files.map(fileToBase64));
            userMessageData.image_base64 = files.length === 1 ? base64Strings[0] : JSON.stringify(base64Strings);
        }
        
        // Optimistic Update
        const optimisticUserMessage: Message = { ...userMessageData, id: tempUserMsgId, created_at: new Date().toISOString() };
        // Remove default 'generating' status to prevent premature loader
        const tempAiMessage: Message = { id: tempId, project_id: chatToUse.project_id, chat_id: chatToUse.id, text: '', sender: 'ai' };
        
        setMessages(prev => [...prev, optimisticUserMessage, tempAiMessage]);
        setIsLoading(true);

        // Save User Message
        let savedUserMessage: Message;
        try {
            savedUserMessage = await addMessage(supabase, userMessageData);
            // Replace temp user message with real one
            setMessages(prev => prev.map(m => m.id === tempUserMsgId ? savedUserMessage : m));
        } catch (dbError) {
             console.error("Failed to save user message:", dbError);
             // We keep the optimistic one so the chat doesn't break, but log error
             savedUserMessage = optimisticUserMessage; 
        }

        const historyWithPlan = [...messages, savedUserMessage];

        const onStreamChunk = (chunk: string) => {
            // Detect if chunk is JSON event for image generation
            try {
                if (chunk.includes('image_generation_start')) {
                     // Check if it's a pure JSON chunk or mixed
                     const match = chunk.match(/\{.*"type":\s*"image_generation_start".*\}/);
                     if (match) {
                         setMessages(prev => prev.map(m => m.id === tempId ? { ...m, imageStatus: 'generating' } : m));
                         // Remove the JSON part from the chunk so it doesn't show up in text
                         const textPart = chunk.replace(match[0], '');
                         if (textPart) {
                             currentText += textPart;
                             setMessages(prev => prev.map(m => m.id === tempId ? { ...m, text: currentText } : m));
                         }
                         return;
                     }
                }
            } catch (e) {}
            
            currentText += chunk;
            setMessages(prev => prev.map(m => m.id === tempId ? { ...m, text: currentText, imageStatus: undefined } : m));
        };

        const projectForAgent = chatToUse.projects ?? { ...DUMMY_AUTONOMOUS_PROJECT, user_id: user.id };

        const agentResult = await runAgent({
            prompt: text,
            files, 
            apiKey: geminiApiKey, 
            model: projectForAgent.default_model,
            project: projectForAgent, 
            chat: chatToUse, 
            user, 
            profile, 
            supabase,
            history: historyWithPlan, 
            onStreamChunk, 
            workspaceMode
        });
        
        const { messages: agentMessages, updatedPlan } = agentResult;
        
        // Save AI Messages to DB
        const savedAiMessages: Message[] = [];
        for (const messageContent of agentMessages) {
            const finalContent = messageContent.text || currentText; 
            try {
                const savedAiMessage = await addMessage(supabase, { ...messageContent, text: finalContent, project_id: chatToUse.project_id });
                savedAiMessages.push(savedAiMessage);
            } catch (aiDbError) {
                console.error("Failed to save AI message:", aiDbError);
                // We still show the message, but maybe with a retry action in real app
                savedAiMessages.push({ ...messageContent, id: `failed-${Date.now()}`, text: finalContent, created_at: new Date().toISOString() } as Message);
                addToast("Failed to save AI response.", "error");
            }
        }
        
        // Replace temp AI message with final saved message(s)
        setMessages(prev => {
            const newMessages = [...prev];
            const tempMessageIndex = newMessages.findIndex(m => m.id === tempId);
            if (tempMessageIndex !== -1) {
                if (savedAiMessages.length > 0) {
                    newMessages.splice(tempMessageIndex, 1, ...savedAiMessages);
                } else {
                    // If agent didn't return message (e.g. pure function call), remove temp
                    newMessages.splice(tempMessageIndex, 1);
                }
            } else {
                 newMessages.push(...savedAiMessages);
            }
            
            if (updatedPlan) {
                return newMessages.map(m => m.id === updatedPlan.messageId ? { ...m, plan: updatedPlan.plan } : m);
            }
            return newMessages;
        });

        if (updatedPlan) await updateMessagePlan(supabase, updatedPlan.messageId, updatedPlan.plan);
        
        return agentResult;

      } catch (e: any) {
        const errorMessage = e?.message || "An unknown error occurred.";
        addToast(errorMessage, "error");
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, text: `⚠️ Error: ${errorMessage}`, sender: 'ai' } : m));
        return { messages: [] };
      } finally {
        setIsLoading(false);
        setTimeout(() => { isSendingRef.current = false; }, 500);
      }
    }, [activeChat, supabase, user, geminiApiKey, messages, addToast, profile, workspaceMode]);
    
    return {
        allChats, setAllChats, activeChat, setActiveChat, messages, setMessages,
        isLoading, isCreatingChat, setIsCreatingChat, activeProject,
        handleUpdateChat, handleSelectChat, handleDeleteChat, handleSendMessage,
    };
};
