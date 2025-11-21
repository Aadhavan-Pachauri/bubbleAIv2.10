
import { SupabaseClient } from '@supabase/supabase-js';
import { Project, Message, Plan, ProjectPlatform, Profile, Chat, ChatMode, Memory, ProjectType, MemoryLayer, AppSettings, ChatWithProjectData, Notification as AppNotification } from '../types';

// Helper to extract a clean error message
const getErrorMessage = (error: any): string => {
    if (!error) return "An unknown error occurred.";
    if (typeof error === 'string') return error;
    if (error?.message?.trim()) return error.message;
    if (error?.details?.trim()) return error.details;
    if (error?.error_description?.trim()) return error.error_description;
    try {
        const str = JSON.stringify(error);
        return str !== '{}' ? str : "Non-serializable error.";
    } catch {
        return "Unknown error structure.";
    }
};

// Centralized error handler
const handleSupabaseError = (error: any, context: string): never => {
    console.error(`${context}:`, error);
    const message = getErrorMessage(error);
    
    // Handle specific error codes/messages
    if (message.includes('schema cache') || message.includes('PGRST202')) {
        throw new Error(`Database schema sync error. Please refresh the page.`);
    }
    if (message.includes('fetch') || message.includes('Load failed')) {
        throw new Error(`Network error: Please check your connection.`);
    }
    if (message.includes('JWT')) {
        throw new Error(`Session expired. Please sign out and sign in again.`);
    }
    
    throw new Error(`DB Error in ${context}: ${message}`);
};

// Helper to map DB Message (snake_case) to App Message (camelCase)
const mapDbMessageToApp = (dbMsg: any): Message => {
    return {
        ...dbMsg,
        // Map snake_case DB fields to camelCase App fields
        groundingMetadata: dbMsg.grounding_metadata || dbMsg.groundingMetadata || undefined,
        // Ensure UI-only fields are undefined/null coming from DB
        imageStatus: undefined,
    };
};

// Helper to map App Message (camelCase) to DB Message (snake_case)
// Removes UI-only fields like 'imageStatus', 'isOptimistic', etc.
const mapAppMessageToDb = (msg: Partial<Message>) => {
    // Destructure to separate UI-only fields from DB fields
    const { 
        imageStatus, 
        groundingMetadata, 
        // @ts-ignore - isOptimistic might be added by UI
        isOptimistic, 
        // @ts-ignore - memoryToCreate might be added by agents
        memoryToCreate,
        ...rest 
    } = msg;

    return {
        ...rest,
        // Map camelCase to snake_case
        grounding_metadata: groundingMetadata,
    };
};

// === App Settings ===
export const getAppSettings = async (supabase: SupabaseClient): Promise<AppSettings> => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('id', 1).single();
    if (error) handleSupabaseError(error, 'fetch app settings');
    return data;
};

export const updateAppSettings = async (supabase: SupabaseClient, updates: Partial<Omit<AppSettings, 'id' | 'updated_at'>>): Promise<AppSettings> => {
    const { data, error } = await supabase.from('app_settings').update(updates).eq('id', 1).select().single();
    if (error) handleSupabaseError(error, 'update app settings');
    return data;
};

// === Projects ===
export const getProjects = async (supabase: SupabaseClient, userId: string): Promise<Project[]> => {
    const { data, error } = await supabase.from('projects').select('*').eq('user_id', userId).order('updated_at', { ascending: false });
    if (error) handleSupabaseError(error, 'fetch projects');
    return data || [];
};

export const getAllProjects = async (supabase: SupabaseClient): Promise<Project[]> => {
    const { data, error } = await supabase.from('projects').select('*').order('created_at', { ascending: false });
    if (error) handleSupabaseError(error, 'fetch all projects');
    return data || [];
};

export const createProject = async (supabase: SupabaseClient, userId: string, name: string, platform: ProjectPlatform, projectType: ProjectType, description?: string): Promise<Project> => {
    const { data, error } = await supabase.from('projects').insert({ 
        user_id: userId, name, platform, description: description || 'Newly created project.', 
        status: 'In Progress', default_model: 'gemini-2.5-flash', project_type: projectType,
    }).select().single();
    if (error) handleSupabaseError(error, 'create project');
    return data;
}

export const updateProject = async (supabase: SupabaseClient, projectId: string, updates: Partial<Project>): Promise<Project> => {
    const { data, error } = await supabase.from('projects').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', projectId).select().single();
    if (error) handleSupabaseError(error, 'update project');
    return data;
};

export const deleteProject = async (supabase: SupabaseClient, projectId: string): Promise<void> => {
    const { data: chats } = await supabase.from('chats').select('id').eq('project_id', projectId);
    if (chats && chats.length > 0) {
        const chatIds = chats.map(c => c.id);
        await supabase.from('messages').delete().in('chat_id', chatIds);
        await supabase.from('chats').delete().eq('project_id', projectId);
    }
    const { error } = await supabase.from('projects').delete().eq('id', projectId);
    if (error) handleSupabaseError(error, 'delete project');
};

// === Chats ===
export const getAllChatsForUser = async (supabase: SupabaseClient, userId: string): Promise<ChatWithProjectData[]> => {
    const { data, error } = await supabase.from('chats').select('*, projects(*)').eq('user_id', userId).order('updated_at', { ascending: false });
    if (error) handleSupabaseError(error, 'fetch user chats');
    return (data as ChatWithProjectData[]) || [];
};

export const getChatsForProject = async (supabase: SupabaseClient, projectId: string): Promise<Chat[]> => {
    const { data, error } = await supabase.from('chats').select('*').eq('project_id', projectId).order('created_at', { ascending: true });
    if (error) handleSupabaseError(error, 'fetch project chats');
    return data || [];
};

export const createChat = async (supabase: SupabaseClient, userId: string, name: string, mode: ChatMode, projectId?: string | null): Promise<Chat> => {
    const { data, error } = await supabase.from('chats').insert({
        project_id: projectId, user_id: userId, name, mode, updated_at: new Date().toISOString(),
    }).select().single();
    if (error) handleSupabaseError(error, 'create chat');
    return data;
};

export const updateChat = async (supabase: SupabaseClient, chatId: string, updates: Partial<Chat>): Promise<Chat> => {
    const { data, error } = await supabase.from('chats').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', chatId).select().single();
    if (error) handleSupabaseError(error, 'update chat');
    return data;
};

export const deleteChat = async (supabase: SupabaseClient, chatId: string): Promise<void> => {
    const { error } = await supabase.from('chats').delete().eq('id', chatId);
    if (error) handleSupabaseError(error, 'delete chat');
};

// === Profiles ===
export const createProfile = async (supabase: SupabaseClient, userId: string, displayName: string, avatarUrl: string): Promise<Profile> => {
    const { data, error } = await supabase.from('profiles').upsert({
        id: userId, roblox_username: displayName, avatar_url: avatarUrl, roblox_id: userId,
    }).select().single();
    if (error) handleSupabaseError(error, 'create profile');
    return data;
};

export const updateProfile = async (supabase: SupabaseClient, userId: string, updates: Partial<Profile>): Promise<Profile> => {
    const { data, error } = await supabase.from('profiles').update(updates).eq('id', userId).select().single();
    if (error) handleSupabaseError(error, 'update profile');
    return data;
};

export const getAllProfiles = async (supabase: SupabaseClient): Promise<Profile[]> => {
    const { data, error } = await supabase.from('profiles').select('*').order('roblox_username', { ascending: true });
    if (error) handleSupabaseError(error, 'fetch profiles');
    return data || [];
};

export const updateProfileForAdmin = async (supabase: SupabaseClient, userId: string, updates: Partial<Profile>): Promise<Profile> => {
    const { data, error } = await supabase.from('profiles').update(updates).eq('id', userId).select().single();
    if (error) handleSupabaseError(error, 'admin update profile');
    return data;
};

export const incrementThinkingCount = async (supabase: SupabaseClient, userId: string): Promise<void> => {
    try {
        const today = new Date().toISOString().split('T')[0];
        await supabase.rpc('increment_thinking_count', { p_user_id: userId, p_date: today });
    } catch (e) { console.warn("Failed to increment stats", e); }
};

export const deleteUser = async (supabase: SupabaseClient, userId: string): Promise<void> => {
    // 1. Delete projects (handles associated chats/messages)
    const { data: projects } = await supabase.from('projects').select('id').eq('user_id', userId);
    if (projects) {
        for (const p of projects) {
            await deleteProject(supabase, p.id);
        }
    }

    // 2. Delete autonomous chats (no project_id) and their messages
    const { data: chats } = await supabase.from('chats').select('id').eq('user_id', userId).is('project_id', null);
    if (chats && chats.length > 0) {
        const chatIds = chats.map(c => c.id);
        await supabase.from('messages').delete().in('chat_id', chatIds);
        await supabase.from('chats').delete().in('id', chatIds);
    }

    // 3. Delete memories
    await supabase.from('memories').delete().eq('user_id', userId);

    // 4. Delete notifications & friendships (best effort)
    try {
        await supabase.from('notifications').delete().eq('user_id', userId);
        await supabase.from('friendships').delete().or(`user_id.eq.${userId},friend_id.eq.${userId}`);
    } catch (e) {
        console.warn("Could not cleanup social data during user deletion", e);
    }

    // 5. Finally delete profile
    const { error } = await supabase.from('profiles').delete().eq('id', userId);
    if (error) handleSupabaseError(error, 'delete user');
};

// === Messages ===
export const getMessages = async (supabase: SupabaseClient, chatId: string): Promise<Message[]> => {
    const { data, error } = await supabase.from('messages').select('*').eq('chat_id', chatId).order('created_at', { ascending: true });
    if (error) handleSupabaseError(error, 'fetch messages');
    return (data || []).map(mapDbMessageToApp);
};

export const addMessage = async (supabase: SupabaseClient, message: Omit<Message, 'id' | 'created_at'>): Promise<Message> => {
    const dbMessage = mapAppMessageToDb(message);
    const { data, error } = await supabase.from('messages').insert(dbMessage).select().single();
    if (error) handleSupabaseError(error, 'add message');
    return mapDbMessageToApp(data);
};

export const updateMessage = async (supabase: SupabaseClient, messageId: string, updates: Partial<Message>): Promise<Message> => {
    const dbUpdates = mapAppMessageToDb(updates);
    const { data, error } = await supabase.from('messages').update(dbUpdates).eq('id', messageId).select().single();
    if (error) handleSupabaseError(error, 'update message');
    return mapDbMessageToApp(data);
};

export const deleteMessage = async (supabase: SupabaseClient, messageId: string): Promise<void> => {
    const { error } = await supabase.from('messages').delete().eq('id', messageId);
    if (error) handleSupabaseError(error, 'delete message');
};

export const updateMessagePlan = async (supabase: SupabaseClient, messageId: string, plan: Plan): Promise<Message> => {
    const { data, error } = await supabase.from('messages').update({ plan }).eq('id', messageId).select().single();
    if (error) handleSupabaseError(error, 'update plan');
    return mapDbMessageToApp(data);
};

// === Memories ===
export const loadMemoriesForPrompt = async (supabase: SupabaseClient, userId: string, prompt: string, projectId?: string | null): Promise<string> => {
    const { data } = await supabase.from('memories').select('layer, content, metadata').eq('user_id', userId);
    if (!data || data.length === 0) return "=== MEMORIES ===\nNone.";
    
    // Basic relevance check
    const relevant = data.filter(m => {
        if (m.layer === 'personal' || m.layer === 'aesthetic') return true;
        if (projectId && (m.layer === 'project' || m.layer === 'codebase')) return m.metadata?.project_id === projectId;
        return false;
    });

    const grouped: Record<string, string[]> = { personal: [], project: [], codebase: [], aesthetic: [] };
    relevant.forEach(m => {
        const key = m.metadata?.memory_key || 'info';
        if (grouped[m.layer as string]) grouped[m.layer as string].push(`[${key}]: ${m.content}`);
    });

    return `=== MEMORIES ===\n${Object.entries(grouped).map(([k, v]) => v.length ? `${k.toUpperCase()}:\n${v.join('\n')}` : '').join('\n\n').trim()}`;
};

export const saveMemory = async (supabase: SupabaseClient, userId: string, layer: MemoryLayer, key: string, value: string, projectId?: string | null): Promise<Memory> => {
    // Check existing
    const { data: existing } = await supabase.from('memories').select('id').eq('user_id', userId).eq('layer', layer).eq('metadata->>memory_key', key).single();
    
    const payload = {
        user_id: userId, layer, content: value,
        metadata: { memory_key: key, project_id: projectId },
        updated_at: new Date().toISOString()
    };

    let data;
    if (existing) {
        const res = await supabase.from('memories').update(payload).eq('id', existing.id).select().single();
        data = res.data;
    } else {
        const res = await supabase.from('memories').insert(payload).select().single();
        data = res.data;
    }
    
    return { ...data, key: data.metadata?.memory_key || key, value: data.content };
};

export const getMemoriesForUser = async (supabase: SupabaseClient, userId: string): Promise<Memory[]> => {
    const { data, error } = await supabase.from('memories').select('*').eq('user_id', userId);
    if (error) handleSupabaseError(error, 'fetch memories');
    return (data || []).map((m: any) => ({ ...m, key: m.metadata?.memory_key || 'unknown', value: m.content }));
};

export const updateMemory = async (supabase: SupabaseClient, memoryId: string, updates: any): Promise<Memory> => {
    const { data, error } = await supabase.from('memories').update({ 
        content: updates.value, 
        metadata: updates.key ? { memory_key: updates.key } : undefined 
    }).eq('id', memoryId).select().single();
    if (error) handleSupabaseError(error, 'update memory');
    return { ...data, key: data.metadata?.memory_key, value: data.content };
};

export const deleteMemory = async (supabase: SupabaseClient, memoryId: string): Promise<void> => {
    const { error } = await supabase.from('memories').delete().eq('id', memoryId);
    if (error) handleSupabaseError(error, 'delete memory');
};

// --- Notifications & Friends (Stubs for context) ---
export const getNotifications = async (supabase: SupabaseClient, userId: string): Promise<AppNotification[]> => {
    const { data } = await supabase.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    return data || [];
};
export const getFriendships = async (supabase: SupabaseClient, userId: string) => {
    const { data } = await supabase.from('friendships').select('*, other_user:friend_id(*)').eq('user_id', userId).eq('status', 'accepted');
    return data || [];
};
export const getPendingFriendRequests = async (supabase: SupabaseClient, userId: string) => {
    const { data } = await supabase.from('friendships').select('*, sender:user_id(*)').eq('friend_id', userId).eq('status', 'pending');
    return data || [];
};
export const getOutgoingFriendRequests = async (supabase: SupabaseClient, userId: string) => {
    const { data } = await supabase.from('friendships').select('*').eq('user_id', userId).eq('status', 'pending');
    return data || [];
};
export const searchUsers = async (supabase: SupabaseClient, query: string, currentUserId: string) => {
    const { data } = await supabase.from('profiles').select('*').ilike('roblox_username', `%${query}%`).neq('id', currentUserId).limit(20);
    return data || [];
};
export const sendFriendRequest = async (supabase: SupabaseClient, userId: string, friendId: string) => {
    await supabase.from('friendships').insert({ user_id: userId, friend_id: friendId, status: 'pending' });
};
export const updateFriendRequest = async (supabase: SupabaseClient, id: string, status: string) => {
    await supabase.from('friendships').update({ status }).eq('id', id);
};

export type { ChatWithProjectData };
export const updateDbChat = updateChat;
