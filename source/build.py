from PIL import Image, ImageDraw, ImageFont
import base64, io, json
# Uygulama simgeleri (source/icons/*.png, 1024'lük SVG'den üretildi)
icon = lambda n: base64.b64encode(open(f'source/icons/icon{n}.png','rb').read()).decode()
b64, b192, b512 = icon(180), icon(192), icon(512)
srv=open('source/server.js').read()
a="if (path === '/icon.svg' || path === '/apple-touch-icon.png') return new Response(ICON_SVG,"
assert a in srv
srv=srv.replace(a,"if (path === '/apple-touch-icon.png' || path === '/icon-192.png' || path === '/icon-512.png') return new Response(Uint8Array.from(atob(path === '/icon-192.png' ? ICON_192 : path === '/icon-512.png' ? ICON_512 : ICON_PNG), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });\n      if (path === '/icon.svg') return new Response(ICON_SVG,")
srv=srv.replace("icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }]","icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }]")
html=open('source/app.html').read()
import hashlib
build=hashlib.sha1((html+srv).encode()).hexdigest()[:10]
html=html.replace('__BUILD__', build); srv=srv.replace('__BUILD__', build)
open('src/worker.js','w').write(srv+"\nconst ICON_PNG = '"+b64+"';\nconst ICON_192 = '"+b192+"';\nconst ICON_512 = '"+b512+"';\nconst APP_HTML = "+json.dumps(html, ensure_ascii=False)+";\n")
print('built', len(srv))
