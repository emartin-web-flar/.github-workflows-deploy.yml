export default {
  async fetch(request, env, ctx) {
    const targetUrl = "https://www.community-christian.net/sharpsburg-counseling";

    // Fetch the target site
    const res = await fetch(targetUrl, {
      headers: { "User-Agent": "Cloudflare-Worker" }
    });

    let text = await res.text();

    // Rewrite internal links to stay on your domain
    text = text.replace(
      /https:\/\/www\.community-christian\.net\/sharpsburg-counseling/g,
      "https://sharpsburgcounseling.com"
    );

    return new Response(text, {
      headers: { "content-type": "text/html;charset=UTF-8" }
    });
  }
};
