from PIL import Image, ImageDraw, ImageFont
import base64, io, json
img=Image.new('RGB',(180,180),(31,58,48)); d=ImageDraw.Draw(img)
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',120)
bb=d.textbbox((0,0),'L',font=font); w=bb[2]-bb[0]; h=bb[3]-bb[1]
d.text(((180-w)/2-bb[0],(180-h)/2-bb[1]),'L',font=font,fill=(241,238,223))
buf=io.BytesIO(); img.save(buf,'PNG'); b64=base64.b64encode(buf.getvalue()).decode()
srv=open('source/server.js').read()
a="if (path === '/icon.svg' || path === '/apple-touch-icon.png') return new Response(ICON_SVG,"
assert a in srv
srv=srv.replace(a,"if (path === '/apple-touch-icon.png') return new Response(Uint8Array.from(atob(ICON_PNG), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });\n      if (path === '/icon.svg') return new Response(ICON_SVG,")
srv=srv.replace("icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }]","icons: [{ src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }]")
html=open('source/app.html').read()
open('src/worker.js','w').write(srv+"\nconst ICON_PNG = '"+b64+"';\nconst APP_HTML = "+json.dumps(html, ensure_ascii=False)+";\n")
print('built', len(srv))
