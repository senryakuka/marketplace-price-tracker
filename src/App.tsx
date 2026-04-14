import { useEffect, useState, FormEvent, ChangeEvent, useRef } from 'react';
import { signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, getDocFromServer, writeBatch } from 'firebase/firestore';
import { auth, db } from './firebase';
import { Plus, Trash2, Edit2, ExternalLink, LogOut, CheckCircle2, XCircle, RefreshCw, Sparkles, Loader2, FileUp } from 'lucide-react';
import { GoogleGenAI, Type } from '@google/genai';
import Papa from 'papaparse';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
}

interface SearchResult {
  title: string;
  price: number;
  url: string;
  imageUrl?: string;
  similarityScore: number; // 0 to 1
}

interface Item {
  id: string;
  name: string;
  marketplaceUrl: string;
  offlinePrice: number;
  onlinePrice?: number; // Kept for legacy compatibility
  tokopediaPrice?: number;
  shopeePrice?: number;
  tokopediaMatch?: SearchResult;
  shopeeMatch?: SearchResult;
  lastCheckedAt?: any;
  createdAt: any;
  userId: string;
  searchResults?: SearchResult[];
  tiktokProductId?: string;
  tiktokSkuId?: string;
  shopeeItemId?: string;
  shopeeModelId?: string;
}

interface AiLog {
  id: string;
  userId: string;
  timestamp: any;
  model: string;
  prompt: string;
  response: string;
  usage?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  type: string;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [aiLogs, setAiLogs] = useState<AiLog[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [offlinePrice, setOfflinePrice] = useState('');
  const [tokopediaPrice, setTokopediaPrice] = useState('');
  const [shopeePrice, setShopeePrice] = useState('');
  const [tiktokProductId, setTiktokProductId] = useState('');
  const [tiktokSkuId, setTiktokSkuId] = useState('');
  const [shopeeItemId, setShopeeItemId] = useState('');
  const [shopeeModelId, setShopeeModelId] = useState('');
  const [checkingId, setCheckingId] = useState<string | null>(null);
  
  // Shop settings
  const [tokopediaUrl, setTokopediaUrl] = useState(() => localStorage.getItem('tokopediaUrl') || '');
  const [tokopediaName, setTokopediaName] = useState(() => localStorage.getItem('tokopediaName') || '');
  const [shopeeUrl, setShopeeUrl] = useState(() => localStorage.getItem('shopeeUrl') || '');
  const [shopeeName, setShopeeName] = useState(() => localStorage.getItem('shopeeName') || '');
  const [isConfirmingTokopedia, setIsConfirmingTokopedia] = useState(false);
  const [isConfirmingShopee, setIsConfirmingShopee] = useState(false);
  const [isBulkChecking, setIsBulkChecking] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncingShopeeId, setSyncingShopeeId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem('tokopediaUrl', tokopediaUrl);
    localStorage.setItem('tokopediaName', tokopediaName);
    localStorage.setItem('shopeeUrl', shopeeUrl);
    localStorage.setItem('shopeeName', shopeeName);
  }, [tokopediaUrl, tokopediaName, shopeeUrl, shopeeName]);

  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setItems([]);
      setAiLogs([]);
      return;
    }

    // Load user settings
    const fetchSettings = async () => {
      try {
        const docSnap = await getDocFromServer(doc(db, 'userSettings', user.uid));
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.tokopediaUrl) setTokopediaUrl(data.tokopediaUrl);
          if (data.tokopediaName) setTokopediaName(data.tokopediaName);
          if (data.shopeeUrl) setShopeeUrl(data.shopeeUrl);
          if (data.shopeeName) setShopeeName(data.shopeeName);
        }
      } catch (error) {
        console.error("Error fetching settings:", error);
      }
    };
    fetchSettings();

    const qItems = query(collection(db, 'items'), where('userId', '==', user.uid));
    const unsubscribeItems = onSnapshot(qItems, (snapshot) => {
      const fetchedItems = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          // Handle legacy field names
          offlinePrice: data.offlinePrice ?? data.targetPrice ?? 0,
          onlinePrice: data.onlinePrice ?? data.currentPrice ?? 0,
        } as Item;
      });
      // Sort by created at descending
      fetchedItems.sort((a, b) => {
        const timeA = a.createdAt?.toMillis() || 0;
        const timeB = b.createdAt?.toMillis() || 0;
        return timeB - timeA;
      });
      setItems(fetchedItems);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'items');
    });

    const qLogs = query(collection(db, 'aiLogs'), where('userId', '==', user.uid));
    const unsubscribeLogs = onSnapshot(qLogs, (snapshot) => {
      const logsList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AiLog));
      // Sort logs by timestamp descending
      logsList.sort((a, b) => {
        const timeA = a.timestamp?.toMillis() || 0;
        const timeB = b.timestamp?.toMillis() || 0;
        return timeB - timeA;
      });
      setAiLogs(logsList);
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'aiLogs'));

    return () => {
      unsubscribeItems();
      unsubscribeLogs();
    };
  }, [user]);

  const logAiCall = async (type: string, model: string, prompt: string, response: string, usage?: any) => {
    if (!user) return;
    try {
      await addDoc(collection(db, 'aiLogs'), {
        userId: user.uid,
        timestamp: serverTimestamp(),
        model,
        prompt,
        response,
        usage: usage ? {
          promptTokenCount: usage.promptTokenCount,
          candidatesTokenCount: usage.candidatesTokenCount,
          totalTokenCount: usage.totalTokenCount
        } : null,
        type
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'aiLogs');
    }
  };

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleLogout = () => {
    signOut(auth);
  };

  const resetForm = () => {
    setName('');
    setOfflinePrice('');
    setTokopediaPrice('');
    setShopeePrice('');
    setTiktokProductId('');
    setTiktokSkuId('');
    setShopeeItemId('');
    setShopeeModelId('');
    setIsAdding(false);
    setEditingItem(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const itemData: any = {
      userId: user.uid,
      name,
      marketplaceUrl: '', // Deprecated in UI but kept for schema compatibility
      offlinePrice: Number(offlinePrice),
      tiktokProductId,
      tiktokSkuId,
      shopeeItemId,
      shopeeModelId,
      lastCheckedAt: serverTimestamp(),
    };
    if (tokopediaPrice) itemData.tokopediaPrice = Number(tokopediaPrice);
    if (shopeePrice) itemData.shopeePrice = Number(shopeePrice);

    try {
      if (editingItem) {
        await updateDoc(doc(db, 'items', editingItem.id), itemData);
      } else {
        await addDoc(collection(db, 'items'), {
          ...itemData,
          createdAt: serverTimestamp(),
        });
      }
      resetForm();
    } catch (error) {
      handleFirestoreError(error, editingItem ? OperationType.UPDATE : OperationType.CREATE, 'items');
    }
  };

  const handleDelete = async (id: string | null) => {
    if (!id) return;
    setDeleteConfirmId(null);
    try {
      await deleteDoc(doc(db, 'items', id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `items/${id}`);
    }
  };

  const startEdit = (item: Item) => {
    setEditingItem(item);
    setName(item.name);
    setOfflinePrice((item.offlinePrice ?? 0).toString());
    setTokopediaPrice(item.tokopediaPrice ? item.tokopediaPrice.toString() : '');
    setShopeePrice(item.shopeePrice ? item.shopeePrice.toString() : '');
    setTiktokProductId(item.tiktokProductId || '');
    setTiktokSkuId(item.tiktokSkuId || '');
    setShopeeItemId(item.shopeeItemId || '');
    setShopeeModelId(item.shopeeModelId || '');
    setIsAdding(true);
  };

  const updatePrices = async (item: Item, tokopediaPrice?: number, shopeePrice?: number, tokopediaMatch?: SearchResult, shopeeMatch?: SearchResult) => {
    try {
      const updateData: any = {
        lastCheckedAt: serverTimestamp(),
      };
      if (tokopediaPrice !== undefined && tokopediaPrice !== -1) updateData.tokopediaPrice = tokopediaPrice;
      if (shopeePrice !== undefined && shopeePrice !== -1) updateData.shopeePrice = shopeePrice;
      if (tokopediaMatch) updateData.tokopediaMatch = tokopediaMatch;
      if (shopeeMatch) updateData.shopeeMatch = shopeeMatch;

      await updateDoc(doc(db, 'items', item.id), updateData);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `items/${item.id}`);
    }
  };

  const handleSyncToTikTok = async (item: Item) => {
    if (!item.tiktokProductId || !item.tiktokSkuId) {
      setError("Please set TikTok Product ID and SKU ID for this item first.");
      return;
    }

    const targetOnlinePrice = Math.round(item.offlinePrice * 1.2);
    setSyncingId(item.id);
    
    try {
      const response = await fetch('/api/tiktok/update-price', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          productId: item.tiktokProductId,
          skuId: item.tiktokSkuId,
          price: targetOnlinePrice,
        }),
      });

      const data = await response.json();
      
      if (response.ok && data.code === 0) {
        await updateDoc(doc(db, 'items', item.id), { lastCheckedAt: serverTimestamp() });
        setError(null);
        alert(`Successfully synced price (Rp ${targetOnlinePrice.toLocaleString('id-ID')}) to TikTok Shop!`);
      } else {
        setError(data.message || data.error || "Failed to sync with TikTok Shop. Check your API credentials.");
      }
    } catch (error) {
      console.error("Sync Error:", error);
      setError("Network error while syncing with TikTok Shop.");
    } finally {
      setSyncingId(null);
    }
  };

  const handleSyncToShopee = async (item: Item) => {
    if (!item.shopeeItemId) {
      setError("Please set Shopee Item ID for this item first.");
      return;
    }

    const targetOnlinePrice = Math.round(item.offlinePrice * 1.2);
    setSyncingShopeeId(item.id);
    
    try {
      const response = await fetch('/api/shopee/update-price', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          itemId: item.shopeeItemId,
          modelId: item.shopeeModelId || 0,
          price: targetOnlinePrice,
        }),
      });

      const data = await response.json();
      
      if (response.ok && !data.error && (!data.message || data.message === 'success' || data.message === '')) {
        await updatePrices(item, undefined, targetOnlinePrice);
        setError(null);
        alert(`Successfully synced price (Rp ${targetOnlinePrice.toLocaleString('id-ID')}) to Shopee!`);
      } else {
        setError(data.message || data.error || "Failed to sync with Shopee. Check your API credentials.");
      }
    } catch (error) {
      console.error("Sync Error:", error);
      setError("Network error while syncing with Shopee.");
    } finally {
      setSyncingShopeeId(null);
    }
  };

  const handleAutoCheck = async (item: Item) => {
    setCheckingId(item.id);
    setError(null);

    try {
      if (!tokopediaUrl && !shopeeUrl) {
        setError("Please set at least one Shop URL first to use AI check.");
        setCheckingId(null);
        return;
      }

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
      
      const shops = [];
      if (tokopediaUrl) shops.push({ name: tokopediaName || 'Tokopedia', url: tokopediaUrl });
      if (shopeeUrl) shops.push({ name: shopeeName || 'Shopee', url: shopeeUrl });

      const prompt = `Search the web to find the current listed price for the item "${item.name}" in these shops:
${shops.map(s => `- ${s.name}: ${s.url}`).join('\n')}

Find the exact current price it is being sold for right now. 
If the item is found in multiple shops, prioritize the one with the most accurate match or the lowest price.

CRITICAL: Many products have variants (e.g., different sizes like 16cm-2 vs 16cm-4, colors, or models) with different prices. 
1. Carefully analyze the product title and description to find the variant that matches "${item.name}" most closely.
2. If multiple variants exist on the same page, ensure you return the price for the specific variant requested.
3. If you find a search result that lists multiple prices, pick the one that corresponds to the specific name: "${item.name}".

Identify the top match for Tokopedia (if searched) and the top match for Shopee (if searched).
For each match, provide:
1. The product title (include variant details if found)
2. The price found
3. The URL to the product page
4. A similarity score from 0 to 1 (how well it matches "${item.name}")
5. (Optional) An image URL if clearly visible in search results

Return a JSON object with:
- "tokopediaPrice": the numeric value of the best match in Tokopedia (return -1 if not found or not searched)
- "tokopediaMatch": an object with the top Tokopedia result (or null if not found)
- "shopeePrice": the numeric value of the best match in Shopee (return -1 if not found or not searched)
- "shopeeMatch": an object with the top Shopee result (or null if not found)`;

      const model = 'gemini-3-flash-preview';
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              tokopediaPrice: { type: Type.NUMBER },
              shopeePrice: { type: Type.NUMBER },
              tokopediaMatch: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  price: { type: Type.NUMBER },
                  url: { type: Type.STRING },
                  imageUrl: { type: Type.STRING },
                  similarityScore: { type: Type.NUMBER }
                }
              },
              shopeeMatch: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  price: { type: Type.NUMBER },
                  url: { type: Type.STRING },
                  imageUrl: { type: Type.STRING },
                  similarityScore: { type: Type.NUMBER }
                }
              }
            }
          }
        }
      });

      const text = response.text;
      console.log("AI Response Text:", text);
      
      if (text) {
        // Clean the text in case the model wrapped it in markdown code blocks
        const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(cleanedText);
        console.log("Parsed AI Data:", data);

        if ((data.tokopediaPrice !== undefined && data.tokopediaPrice !== -1) || (data.shopeePrice !== undefined && data.shopeePrice !== -1)) {
          await updatePrices(item, data.tokopediaPrice, data.shopeePrice, data.tokopediaMatch, data.shopeeMatch);
        } else {
          console.warn(`Could not automatically determine the price for ${item.name}.`);
        }
        // Log the AI call
        await logAiCall('price_check', model, prompt, cleanedText, response.usageMetadata);
      }
    } catch (error) {
      console.error("Error checking price:", error);
      setError("Error during auto-check. Check console for details.");
    } finally {
      setCheckingId(null);
    }
  };

  const handleBulkCheck = async () => {
    if (!tokopediaUrl && !shopeeUrl) {
      setError("Please enter at least one Shop URL first so the AI knows where to search.");
      return;
    }
    
    setIsBulkChecking(true);
    for (const item of items) {
      await handleAutoCheck(item);
      // Add a small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    setIsBulkChecking(false);
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user) return;

    setIsImporting(true);
    setError(null);

    try {
      const text = await file.text();
      let parsedData: any[] = [];

      if (file.name.endsWith('.json')) {
        parsedData = JSON.parse(text);
        if (!Array.isArray(parsedData)) {
          throw new Error("JSON file must contain an array of items.");
        }
      } else if (file.name.endsWith('.csv')) {
        const result = Papa.parse(text, { header: true, skipEmptyLines: true });
        if (result.errors.length > 0) {
          throw new Error(`CSV Parsing Error: ${result.errors[0].message}`);
        }
        parsedData = result.data;
      } else {
        throw new Error("Unsupported file format. Please upload a .csv or .json file.");
      }

      const batch = writeBatch(db);
      let validCount = 0;

      for (const item of parsedData) {
        if (!item.name || item.offlinePrice === undefined) {
          continue;
        }

        const itemRef = doc(collection(db, 'items'));
        const itemData: any = {
          userId: user.uid,
          name: String(item.name),
          marketplaceUrl: item.marketplaceUrl || '',
          offlinePrice: Number(item.offlinePrice),
          tiktokProductId: item.tiktokProductId || '',
          tiktokSkuId: item.tiktokSkuId || '',
          shopeeItemId: item.shopeeItemId || '',
          shopeeModelId: item.shopeeModelId || '',
          createdAt: serverTimestamp(),
        };
        
        if (item.tokopediaPrice !== undefined) itemData.tokopediaPrice = Number(item.tokopediaPrice);
        if (item.shopeePrice !== undefined) itemData.shopeePrice = Number(item.shopeePrice);
        if (item.onlinePrice !== undefined) itemData.onlinePrice = Number(item.onlinePrice); // Legacy support

        batch.set(itemRef, itemData);
        validCount++;
      }

      if (validCount > 0) {
        await batch.commit();
        setError(null);
      } else {
        setError("No valid items found in the file. Ensure columns: name, offlinePrice exist.");
      }
    } catch (err) {
      console.error("Import error:", err);
      setError(err instanceof Error ? err.message : "Failed to import file.");
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const saveSettings = async (updates: any) => {
    if (!user) return;
    try {
      // Use setDoc with merge to create or update the document
      const { setDoc } = await import('firebase/firestore');
      await setDoc(doc(db, 'userSettings', user.uid), updates, { merge: true });
    } catch (error) {
      console.error("Error saving settings:", error);
    }
  };

  const handleConfirmShop = async (type: 'tokopedia' | 'shopee') => {
    const url = type === 'tokopedia' ? tokopediaUrl : shopeeUrl;
    if (!url) return;
    
    if (type === 'tokopedia') setIsConfirmingTokopedia(true);
    else setIsConfirmingShopee(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
      const prompt = `Identify the name of the online shop at this URL: ${url}. 
Return a JSON object with a single key "shopName" containing the name of the shop. If you cannot find a specific name, return "My Shop".`;

      const model = 'gemini-3-flash-preview';
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              shopName: { type: Type.STRING }
            }
          }
        }
      });

      const text = response.text;
      if (text) {
        const data = JSON.parse(text);
        if (type === 'tokopedia') {
          const newName = data.shopName || 'Tokopedia Shop';
          setTokopediaName(newName);
          await saveSettings({ tokopediaUrl: url, tokopediaName: newName });
        } else {
          const newName = data.shopName || 'Shopee Shop';
          setShopeeName(newName);
          await saveSettings({ shopeeUrl: url, shopeeName: newName });
        }
        // Log the AI call
        await logAiCall('shop_confirm', model, prompt, text, response.usageMetadata);
      }
    } catch (error) {
      console.error(`Error confirming ${type} shop:`, error);
      if (type === 'tokopedia') {
        setTokopediaName('Tokopedia Shop');
        await saveSettings({ tokopediaUrl: url, tokopediaName: 'Tokopedia Shop' });
      } else {
        setShopeeName('Shopee Shop');
        await saveSettings({ shopeeUrl: url, shopeeName: 'Shopee Shop' });
      }
    } finally {
      if (type === 'tokopedia') setIsConfirmingTokopedia(false);
      else setIsConfirmingShopee(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-500">Loading...</div>;
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-6">
            <RefreshCw className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Marketplace Price Tracker</h1>
          <p className="text-gray-500 mb-8">Track your target prices against current marketplace listings.</p>
          <button
            onClick={handleLogin}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-xl transition-colors"
          >
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 text-blue-600">
            <RefreshCw className="w-6 h-6" />
            <span className="font-bold text-lg text-gray-900">Price Tracker</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600 hidden sm:inline-block">{user.email}</span>
            <button
              onClick={handleLogout}
              className="text-gray-500 hover:text-gray-700 p-2 rounded-full hover:bg-gray-100 transition-colors"
              title="Sign out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex justify-between items-center">
            <div className="flex items-center gap-2">
              <XCircle className="w-5 h-5" />
              <span className="text-sm font-medium">{error}</span>
            </div>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
              <Plus className="w-5 h-5 rotate-45" />
            </button>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-6">
            {/* Tokopedia Shop */}
            <div>
              {tokopediaName && !isConfirmingTokopedia ? (
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-green-100 text-green-600 rounded-full flex items-center justify-center">
                      <RefreshCw className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-gray-900">{tokopediaName}</h3>
                      <p className="text-xs text-gray-500 truncate max-w-[150px] sm:max-w-xs">{tokopediaUrl}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setTokopediaName('');
                      saveSettings({ tokopediaUrl: '', tokopediaName: '' });
                    }}
                    className="text-xs font-medium text-gray-500 hover:text-gray-700 underline"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <label className="block text-xs font-medium text-gray-700">Tokopedia Shop URL</label>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={tokopediaUrl}
                      onChange={(e) => setTokopediaUrl(e.target.value)}
                      className="flex-grow px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none"
                      placeholder="Tokopedia URL"
                    />
                    <button
                      onClick={() => handleConfirmShop('tokopedia')}
                      disabled={isConfirmingTokopedia || !tokopediaUrl}
                      className="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                    >
                      {isConfirmingTokopedia ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Shopee Shop */}
            <div>
              {shopeeName && !isConfirmingShopee ? (
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-orange-100 text-orange-600 rounded-full flex items-center justify-center">
                      <RefreshCw className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-gray-900">{shopeeName}</h3>
                      <p className="text-xs text-gray-500 truncate max-w-[150px] sm:max-w-xs">{shopeeUrl}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setShopeeName('');
                      saveSettings({ shopeeUrl: '', shopeeName: '' });
                    }}
                    className="text-xs font-medium text-gray-500 hover:text-gray-700 underline"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <label className="block text-xs font-medium text-gray-700">Shopee Shop URL</label>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={shopeeUrl}
                      onChange={(e) => setShopeeUrl(e.target.value)}
                      className="flex-grow px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none"
                      placeholder="Shopee URL"
                    />
                    <button
                      onClick={() => handleConfirmShop('shopee')}
                      disabled={isConfirmingShopee || !shopeeUrl}
                      className="bg-orange-600 hover:bg-orange-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                    >
                      {isConfirmingShopee ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleBulkCheck}
              disabled={isBulkChecking || items.length === 0 || (!tokopediaUrl && !shopeeUrl)}
              className="flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-6 py-2 rounded-lg font-medium transition-colors shadow-sm disabled:opacity-70 whitespace-nowrap"
            >
              {isBulkChecking ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Checking All...</>
              ) : (
                <><Sparkles className="w-4 h-4" /> Bulk Check All</>
              )}
            </button>
          </div>
        </div>

        <div className="flex justify-between items-center mb-8">
          <h2 className="text-2xl font-bold text-gray-900">Your Items</h2>
          {!isAdding && (
            <div className="flex gap-3">
              <button
                onClick={() => setShowLogs(!showLogs)}
                className="flex items-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg font-medium transition-colors shadow-sm"
              >
                <Sparkles className="w-4 h-4" />
                {showLogs ? 'Hide AI Logs' : 'View AI Logs'}
              </button>
              <input 
                type="file" 
                accept=".csv,.json" 
                ref={fileInputRef} 
                onChange={handleFileUpload} 
                className="hidden" 
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isImporting}
                className="flex items-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg font-medium transition-colors shadow-sm disabled:opacity-70"
              >
                {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />}
                Import
              </button>
              <button
                onClick={() => setIsAdding(true)}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors shadow-sm"
              >
                <Plus className="w-4 h-4" />
                Add Item
              </button>
            </div>
          )}
        </div>

        {showLogs && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-8 overflow-hidden">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-gray-900">AI API Usage Logs</h3>
              <button onClick={() => setShowLogs(false)} className="text-gray-400 hover:text-gray-600">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="py-3 px-4 font-semibold text-gray-600">Time</th>
                    <th className="py-3 px-4 font-semibold text-gray-600">Type</th>
                    <th className="py-3 px-4 font-semibold text-gray-600">Model</th>
                    <th className="py-3 px-4 font-semibold text-gray-600">Tokens (P/C/T)</th>
                    <th className="py-3 px-4 font-semibold text-gray-600">Prompt Snippet</th>
                  </tr>
                </thead>
                <tbody>
                  {aiLogs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-gray-500 italic">No logs found yet.</td>
                    </tr>
                  ) : (
                    aiLogs.map((log) => (
                      <tr key={log.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                        <td className="py-3 px-4 text-gray-500 whitespace-nowrap">
                          {log.timestamp?.toDate().toLocaleString('id-ID')}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                            log.type === 'price_check' ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600'
                          }`}>
                            {log.type.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-gray-600 font-mono text-xs">{log.model}</td>
                        <td className="py-3 px-4 text-gray-600">
                          {log.usage ? `${log.usage.promptTokenCount} / ${log.usage.candidatesTokenCount} / ${log.usage.totalTokenCount}` : '-'}
                        </td>
                        <td className="py-3 px-4 text-gray-500 truncate max-w-xs" title={log.prompt}>
                          {log.prompt.substring(0, 50)}...
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {isAdding && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-8">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              {editingItem ? 'Edit Item' : 'Add New Item'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Item Name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="e.g., Vintage Camera"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Offline Price (Rp)</label>
                  <input
                    type="number"
                    required
                    min="0"
                    step="1"
                    value={offlinePrice}
                    onChange={(e) => setOfflinePrice(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="100000"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tokopedia Price (Rp, Optional)</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={tokopediaPrice}
                    onChange={(e) => setTokopediaPrice(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="120000"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Shopee Price (Rp, Optional)</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={shopeePrice}
                    onChange={(e) => setShopeePrice(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="115000"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">TikTok Product ID (Optional)</label>
                  <input
                    type="text"
                    value={tiktokProductId}
                    onChange={(e) => setTiktokProductId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="e.g., 1729384756"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">TikTok SKU ID (Optional)</label>
                  <input
                    type="text"
                    value={tiktokSkuId}
                    onChange={(e) => setTiktokSkuId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="e.g., 283746592"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Shopee Item ID (Optional)</label>
                  <input
                    type="text"
                    value={shopeeItemId}
                    onChange={(e) => setShopeeItemId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="e.g., 987654321"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Shopee Model ID (Optional)</label>
                  <input
                    type="text"
                    value={shopeeModelId}
                    onChange={(e) => setShopeeModelId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="e.g., 12345 (0 if none)"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors shadow-sm"
                >
                  {editingItem ? 'Save Changes' : 'Add Item'}
                </button>
              </div>
            </form>
          </div>
        )}

        {items.length === 0 && !isAdding ? (
          <div className="text-center py-16 bg-white rounded-xl border border-gray-200 border-dashed">
            <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <RefreshCw className="w-8 h-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-1">No items yet</h3>
            <p className="text-gray-500">Add your first item to start tracking its price.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {items.map((item) => {
              const offlinePrice = item.offlinePrice ?? 0;
              const targetOnlinePrice = Math.round(offlinePrice * 1.2);
              const tokoPrice = item.tokopediaPrice || 0;
              const shopeePrice = item.shopeePrice || 0;
              
              const tokoNeedsUpdate = tokoPrice > 0 && tokoPrice < targetOnlinePrice;
              const shopeeNeedsUpdate = shopeePrice > 0 && shopeePrice < targetOnlinePrice;
              const needsUpdate = tokoNeedsUpdate || shopeeNeedsUpdate;
              
              return (
                <div key={item.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col hover:shadow-md transition-shadow">
                  <div className="p-5 flex-grow">
                    <div className="flex justify-between items-start mb-3">
                      <h3 className="font-semibold text-gray-900 text-lg line-clamp-1" title={item.name}>
                        {item.name}
                      </h3>
                      {item.marketplaceUrl && (
                        <a 
                          href={item.marketplaceUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-blue-500 hover:text-blue-700 p-1"
                          title="Open in marketplace"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-2 mb-4">
                      {!needsUpdate ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Price OK
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                          <XCircle className="w-3.5 h-3.5" />
                          Needs Update
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-1 gap-4 mb-4">
                      <div className="bg-gray-50 p-3 rounded-lg">
                        <div className="text-xs text-gray-500 mb-1">Offline Price</div>
                        <div className="font-semibold text-gray-900">Rp {(offlinePrice || 0).toLocaleString('id-ID')}</div>
                        <div className="text-xs text-gray-400 mt-1">Target: Rp {targetOnlinePrice.toLocaleString('id-ID')}</div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 mb-4">
                      <div className={`flex items-center justify-between text-sm px-3 py-2 rounded-lg border ${tokoNeedsUpdate ? 'bg-red-50 text-red-800 border-red-100' : 'bg-green-50 text-green-800 border-green-100'}`}>
                        <span className="font-medium">Tokopedia:</span>
                        <div className="flex items-center gap-2">
                          <span className="font-bold">
                            {tokoPrice > 0 ? `Rp ${tokoPrice.toLocaleString('id-ID')}` : 'Not Set'}
                          </span>
                          {item.tokopediaMatch?.url && (
                            <a href={item.tokopediaMatch.url} target="_blank" rel="noopener noreferrer" className="text-current opacity-70 hover:opacity-100">
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          )}
                        </div>
                      </div>
                      
                      <div className={`flex items-center justify-between text-sm px-3 py-2 rounded-lg border ${shopeeNeedsUpdate ? 'bg-red-50 text-red-800 border-red-100' : 'bg-orange-50 text-orange-800 border-orange-100'}`}>
                        <span className="font-medium">Shopee:</span>
                        <div className="flex items-center gap-2">
                          <span className="font-bold">
                            {shopeePrice > 0 ? `Rp ${shopeePrice.toLocaleString('id-ID')}` : 'Not Set'}
                          </span>
                          {item.shopeeMatch?.url && (
                            <a href={item.shopeeMatch.url} target="_blank" rel="noopener noreferrer" className="text-current opacity-70 hover:opacity-100">
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    <div className="mt-2 flex flex-col gap-2">
                      <button 
                        onClick={() => handleAutoCheck(item)}
                        disabled={checkingId === item.id}
                        className="w-full py-2 text-sm font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-70"
                      >
                        {checkingId === item.id ? (
                          <><Loader2 className="w-4 h-4 animate-spin" /> Checking...</>
                        ) : (
                          <><Sparkles className="w-4 h-4" /> Auto-Check Price</>
                        )}
                      </button>
                      {needsUpdate && (
                        <div className="flex gap-2">
                          {item.tiktokProductId && item.tiktokSkuId && (
                            <button 
                              onClick={() => handleSyncToTikTok(item)}
                              disabled={syncingId === item.id}
                              className="flex-1 py-2 text-sm font-medium text-white bg-black hover:bg-gray-800 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-70"
                            >
                              {syncingId === item.id ? (
                                <><Loader2 className="w-3 h-3 animate-spin" /> Syncing...</>
                              ) : (
                                <><RefreshCw className="w-3 h-3" /> Sync TikTok</>
                              )}
                            </button>
                          )}
                          {item.shopeeItemId && (
                            <button 
                              onClick={() => handleSyncToShopee(item)}
                              disabled={syncingShopeeId === item.id}
                              className="flex-1 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-70"
                            >
                              {syncingShopeeId === item.id ? (
                                <><Loader2 className="w-3 h-3 animate-spin" /> Syncing...</>
                              ) : (
                                <><RefreshCw className="w-3 h-3" /> Sync Shopee</>
                              )}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="bg-gray-50 px-5 py-3 border-t border-gray-100 flex justify-between items-center">
                    <div className="text-xs text-gray-400">
                      {item.lastCheckedAt ? `Checked at ${new Date(item.lastCheckedAt.toDate()).toLocaleDateString()}` : 'Not checked'}
                    </div>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => startEdit(item)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 rounded-md hover:bg-blue-50 transition-colors"
                        title="Edit"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => setDeleteConfirmId(item.id)}
                        className="p-1.5 text-gray-400 hover:text-red-600 rounded-md hover:bg-red-50 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mb-4">
              <Trash2 className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-gray-900 mb-2">Delete Item?</h3>
            <p className="text-gray-500 mb-6">Are you sure you want to delete this item? This action cannot be undone.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="flex-1 px-4 py-2 border border-gray-200 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirmId)}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors shadow-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
