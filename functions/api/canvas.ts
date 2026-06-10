interface Env {
  CANVAS_STORE: KVNamespace;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const data = await context.env.CANVAS_STORE.get("canvas_data");
    return new Response(data || JSON.stringify({ elements: [], appState: {} }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ elements: [], appState: {} }), {
      headers: { "Content-Type": "application/json" }
    });
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const data = await context.request.text();
    await context.env.CANVAS_STORE.put("canvas_data", data);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Failed to save" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
