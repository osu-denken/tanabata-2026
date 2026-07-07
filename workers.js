// Cloudflare Workers上で動作する短冊管理API
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// NGワードの設定 (正規表現)
const NG_PATTERNS = [
  /死亡/i,
  /重傷/i,
  /殺害/i,
  /傷害/i,
  /暴力/i,
  /童貞/i,
  /死ね/i,
  /殺す/i,
  /セックス/i,
  /ポルノ/i,
  /レイプ/i,
  /オナニー?/i,
  /エッチ/i,
  /風俗/i,
  /sex/i,
  /ちん(ぽ|こ|ちん)/i,
  /お?まんこ/i,
  /大麻/i,
  /覚醒剤/i,
  /麻薬/i,  
];

// スリープ関数
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS プリフライトリクエスト
    if (method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      // 竹と短冊データの取得 (GET /api/bamboo?id=[latest or 数値])
      if (method === "GET" && url.pathname === "/api/bamboo") {
        let id = url.searchParams.get("id");
        let latestId = parseInt(await env.TANABATA_KV.get("bamboo:latest_id") || "1");

        if (id === "latest" || !id) {
          id = latestId;
        } else {
          id = parseInt(id);
        }

        const data = await env.TANABATA_KV.get(`bamboo:data:${id}`) || "[]";
        
        return new Response(JSON.stringify({ id: id, wishes: JSON.parse(data), latest_id: latestId }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }

      // 短冊を追加(吊るす) (POST /api/wishes)
      if (method === "POST" && url.pathname === "/api/wishes") {
        const { text, color, slot_index, user_token } = await request.json();
        
        // NGワード規制
        const isNg = NG_PATTERNS.some(regex => regex.test(text));
        if (isNg) {
           return new Response(JSON.stringify({ success: false, error: "不適切な表現が含まれています。" }), {
             status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS }
           });
        }
        
        let attempts = 0;
        const maxAttempts = 3; // 最大3回リトライする（排他制御）

        while (attempts < maxAttempts) {
          // 現在の最新IDを取得
          let latestId = parseInt(await env.TANABATA_KV.get("bamboo:latest_id") || "1");
          
          // その竹の現在のデータを取得
          let currentDataRaw = await env.TANABATA_KV.get(`bamboo:data:${latestId}`);
          let currentData = JSON.parse(currentDataRaw || "[]");

          // 12個満杯なら次の竹のIDを計算
          let targetId = latestId;
          if (currentData.length >= 12) {
            targetId = latestId + 1;
            // 新しい竹のデータを再度読み込み
            currentDataRaw = await env.TANABATA_KV.get(`bamboo:data:${targetId}`);
            currentData = JSON.parse(currentDataRaw || "[]");
          }

          // 指定されたスロットが既に埋まっていないかチェック
          if (currentData.some(w => w.slot_index === slot_index)) {
             return new Response(JSON.stringify({ success: false, error: "Slot already taken" }), {
               status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS }
             });
          }

          // 新しい短冊オブジェクトを作成
          const newWish = { id: crypto.randomUUID(), text, color, slot_index, created_by: user_token };
          currentData.push(newWish);

          // 書き込む直前に、もう一度KVの最新状態を確認する (排他制御っぽくしておく)
          let checkDataRaw = await env.TANABATA_KV.get(`bamboo:data:${targetId}`);
          
          // 自分が読み込んだ時点とKVの状態が変わっていなければ安全とみなす
          if (checkDataRaw === (targetId === latestId ? currentDataRaw : null) || checkDataRaw === null) {
            
            // 竹のIDが繰り上がっていた場合は latest_id を更新
            if (targetId !== latestId) {
              await env.TANABATA_KV.put("bamboo:latest_id", targetId.toString());
            }
            
            // データを確定保存
            await env.TANABATA_KV.put(`bamboo:data:${targetId}`, JSON.stringify(currentData));
            
            return new Response(JSON.stringify({ success: true, bamboo_id: targetId, wish: newWish }), {
              headers: { "Content-Type": "application/json", ...CORS_HEADERS }
            });
          }

          // 他の人が先に書き込んだらリトライ
          attempts++;
          await sleep(100 + Math.random() * 100);
        }

        // すべてのリトライが失敗した場合
        return new Response(JSON.stringify({ success: false, error: "Conflict. Please try again." }), {
          status: 409, headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }

      // 願い！ を加算、解除する (POST /api/wishes/star)
      if (method === "POST" && url.pathname === "/api/wishes/star") {
        const { id, bamboo_id, action } = await request.json();
        
        let currentDataRaw = await env.TANABATA_KV.get(`bamboo:data:${bamboo_id}`);
        if (!currentDataRaw) return new Response("Not Found", { status: 404, headers: CORS_HEADERS });

        let currentData = JSON.parse(currentDataRaw);
        const wishIndex = currentData.findIndex(w => w.id === id);
        
        if (wishIndex !== -1) {
          // アクションに応じて星の数を増減（0未満にはならないように）
          if (action === 'remove') {
            currentData[wishIndex].stars = Math.max(0, (currentData[wishIndex].stars || 0) - 1);
          } else {
            currentData[wishIndex].stars = (currentData[wishIndex].stars || 0) + 1;
          }
          await env.TANABATA_KV.put(`bamboo:data:${bamboo_id}`, JSON.stringify(currentData));
          
          return new Response(JSON.stringify({ success: true, stars: currentData[wishIndex].stars }), {
            headers: { "Content-Type": "application/json", ...CORS_HEADERS }
          });
        }

        return new Response(JSON.stringify({ success: false, error: "Not found" }), { 
          status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } 
        });
      }

      // 短冊の削除 (DELETE /api/wishes)
      if (method === "DELETE" && url.pathname === "/api/wishes") {
        const { id, bamboo_id, user_token } = await request.json();
        
        let currentDataRaw = await env.TANABATA_KV.get(`bamboo:data:${bamboo_id}`);
        let currentData = JSON.parse(currentDataRaw || "[]");

        const wishIndex = currentData.findIndex(w => w.id === id);
        
        if (wishIndex !== -1 && currentData[wishIndex].created_by === user_token) {
          // 所有権が一致した場合のみ削除
          currentData.splice(wishIndex, 1);
          await env.TANABATA_KV.put(`bamboo:data:${bamboo_id}`, JSON.stringify(currentData));
          
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json", ...CORS_HEADERS }
          });
        }

        return new Response(JSON.stringify({ success: false, error: "Unauthorized or not found" }), {
          status: 403, headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }

      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } 
      });
    }
  }
};
