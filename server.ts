import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // TikTok Shop API Update Price Proxy
  app.post("/api/tiktok/update-price", async (req, res) => {
    const { productId, skuId, price } = req.body;

    if (!productId || !skuId || !price) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const appKey = process.env.TIKTOK_APP_KEY;
    const appSecret = process.env.TIKTOK_APP_SECRET;
    const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
    const shopId = process.env.TIKTOK_SHOP_ID;

    if (!appKey || !appSecret || !accessToken || !shopId) {
      return res.status(500).json({ error: "TikTok Shop API credentials not configured" });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const apiPath = "/api/v1/product/prices/update";
    
    // Query parameters
    const params: any = {
      app_key: appKey,
      timestamp: timestamp.toString(),
      shop_id: shopId,
      access_token: accessToken,
    };

    // Body
    const body = {
      product_id: productId,
      skus: [
        {
          id: skuId,
          original_price: price.toString(),
        },
      ],
    };

    // Signature Logic
    const sortedKeys = Object.keys(params).sort();
    let signString = appSecret + apiPath;
    for (const key of sortedKeys) {
      signString += key + params[key];
    }
    signString += JSON.stringify(body) + appSecret;

    const signature = crypto
      .createHmac("sha256", appSecret)
      .update(signString)
      .digest("hex");

    const url = new URL(`https://open-api.tiktokglobalshop.com${apiPath}`);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    url.searchParams.append("sign", signature);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tts-access-token": accessToken,
        },
        body: JSON.stringify(body),
      });

      const result = await response.json();
      res.json(result);
    } catch (error) {
      console.error("TikTok API Error:", error);
      res.status(500).json({ error: "Failed to update price on TikTok Shop" });
    }
  });

  // Shopee API Update Price Proxy
  app.post("/api/shopee/update-price", async (req, res) => {
    const { itemId, modelId, price } = req.body;

    if (!itemId || !price) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const partnerId = process.env.SHOPEE_PARTNER_ID;
    const partnerKey = process.env.SHOPEE_PARTNER_KEY;
    const accessToken = process.env.SHOPEE_ACCESS_TOKEN;
    const shopId = process.env.SHOPEE_SHOP_ID;

    if (!partnerId || !partnerKey || !accessToken || !shopId) {
      return res.status(500).json({ error: "Shopee API credentials not configured" });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const apiPath = "/api/v2/product/update_price";
    
    // Signature Logic: partner_id + api_path + timestamp + access_token + shop_id
    const signString = `${partnerId}${apiPath}${timestamp}${accessToken}${shopId}`;
    const signature = crypto
      .createHmac("sha256", partnerKey)
      .update(signString)
      .digest("hex");

    const url = new URL(`https://partner.shopeemobile.com${apiPath}`);
    url.searchParams.append("partner_id", partnerId);
    url.searchParams.append("timestamp", timestamp.toString());
    url.searchParams.append("access_token", accessToken);
    url.searchParams.append("shop_id", shopId);
    url.searchParams.append("sign", signature);

    const body = {
      item_id: parseInt(itemId, 10),
      price_list: [
        {
          model_id: modelId ? parseInt(modelId, 10) : 0,
          original_price: parseFloat(price),
        },
      ],
    };

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const result = await response.json();
      res.json(result);
    } catch (error) {
      console.error("Shopee API Error:", error);
      res.status(500).json({ error: "Failed to update price on Shopee" });
    }
  });

  // Shopee API Get Price Proxy
  app.get("/api/shopee/get-price", async (req, res) => {
    const { itemId, modelId } = req.query;

    if (!itemId) {
      return res.status(400).json({ error: "Missing itemId" });
    }

    const partnerId = process.env.SHOPEE_PARTNER_ID;
    const partnerKey = process.env.SHOPEE_PARTNER_KEY;
    const accessToken = process.env.SHOPEE_ACCESS_TOKEN;
    const shopId = process.env.SHOPEE_SHOP_ID;

    if (!partnerId || !partnerKey || !accessToken || !shopId) {
      return res.status(500).json({ error: "Shopee API credentials not configured" });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const apiPath = modelId && modelId !== '0' ? "/api/v2/product/get_model_list" : "/api/v2/product/get_item_base_info";
    
    // Signature Logic
    const signString = `${partnerId}${apiPath}${timestamp}${accessToken}${shopId}`;
    const signature = crypto
      .createHmac("sha256", partnerKey)
      .update(signString)
      .digest("hex");

    const url = new URL(`https://partner.shopeemobile.com${apiPath}`);
    url.searchParams.append("partner_id", partnerId);
    url.searchParams.append("timestamp", timestamp.toString());
    url.searchParams.append("access_token", accessToken);
    url.searchParams.append("shop_id", shopId);
    url.searchParams.append("sign", signature);
    
    if (modelId && modelId !== '0') {
      url.searchParams.append("item_id", itemId as string);
    } else {
      url.searchParams.append("item_id_list", itemId as string);
    }

    try {
      const response = await fetch(url.toString());
      const result = await response.json();
      
      let price = null;
      if (modelId && modelId !== '0') {
        const model = result.response?.model?.find((m: any) => m.model_id.toString() === modelId);
        if (model && model.price_info && model.price_info.length > 0) {
          price = model.price_info[0].current_price;
        }
      } else {
        const item = result.response?.item_list?.[0];
        if (item && item.price_info && item.price_info.length > 0) {
          price = item.price_info[0].current_price;
        }
      }

      if (price !== null) {
        res.json({ price });
      } else {
        res.status(404).json({ error: "Price not found in Shopee response", details: result });
      }
    } catch (error) {
      console.error("Shopee API Error:", error);
      res.status(500).json({ error: "Failed to fetch price from Shopee" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
