// This fallback accepts only text-only EPUBs whose missing web scripts cannot hide lost text.
const review = String.raw`import sys,zipfile,posixpath,re,unicodedata,json
from html.parser import HTMLParser
from urllib.parse import unquote
from xml.etree import ElementTree as ET
scripts={'/js/jquery.js','/js/jquery-ui.js','/js/ddslick.js'}
styles={'/css/template_css.css','/css/jquery-ui.css'}
class Content(HTMLParser):
 def __init__(self):
  super().__init__(convert_charrefs=True)
  self.hidden=0
  self.script=False
  self.text=[]
 def handle_starttag(self,tag,attrs):
  attrs=dict(attrs)
  if any(k.startswith('on') for k in attrs): raise ValueError('Event-driven content requires review')
  if tag in ('img','image','svg','canvas','object','embed','iframe','audio','video','source','noscript'):
   raise ValueError('Non-text content requires review')
  if tag=='script':
   if attrs.get('src') not in scripts: raise ValueError('Unknown script requires review')
   self.script=True
  if tag=='link' and attrs.get('rel','').lower()=='stylesheet' and attrs.get('href') not in styles:
   raise ValueError('Unknown stylesheet requires review')
  if tag in ('head','script','style'): self.hidden+=1
 def handle_endtag(self,tag):
  if tag in ('head','script','style'): self.hidden=max(0,self.hidden-1)
  if tag=='script': self.script=False
 def handle_data(self,data):
  if self.script and data.strip(): raise ValueError('Inline script requires review')
  if not self.hidden: self.text.append(data)
def normalize(text):
 text=unicodedata.normalize('NFKC',text).casefold().replace('\u00ad','')
 text=re.sub(r'(?<=\w)-\s*\n\s*(?=\w)','',text)
 return ''.join(re.findall(r'[^\W_]+',text))
with zipfile.ZipFile(sys.argv[1]) as archive:
 if len(archive.infolist())>5000 or sum(e.file_size for e in archive.infolist())>33554432:
  raise ValueError('Static review size limit')
 def read(name):
  if archive.getinfo(name).file_size>4194304: raise ValueError('Static resource size limit')
  return archive.read(name)
 container=ET.fromstring(read('META-INF/container.xml'))
 opf=next(e.get('full-path') for e in container.iter() if e.tag.endswith('}rootfile'))
 package=ET.fromstring(read(opf))
 manifest={e.get('id'):e for e in package.iter() if e.tag.endswith('}item')}
 text=[]
 for ref in (e for e in package.iter() if e.tag.endswith('}itemref')):
  item=manifest[ref.get('idref')]
  if item.get('media-type') not in ('application/xhtml+xml','text/html'): raise ValueError('Non-HTML spine')
  name=posixpath.normpath(posixpath.join(posixpath.dirname(opf),unquote(item.get('href'))))
  content=Content()
  content.feed(read(name).decode('utf-8-sig'))
  content.close()
  text.extend(content.text)
 original=normalize(' '.join(text))
 with open(sys.argv[2],encoding='utf-8') as pdf: converted=normalize(pdf.read(33554433))
 if not original or original!=converted: raise ValueError('Static EPUB/PDF text differs')
 print(json.dumps({'verified':True,'characters':len(original)}))`;

export const staticEpubScriptReview = "def review():\n" + review.split("\n").map(line => " " + line).join("\n") + "\nreview()";
