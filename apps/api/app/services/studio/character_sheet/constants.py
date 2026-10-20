"""设定卡共享常量(拆自 character_sheet 单体;供 templates/gates/layout/retry/_impl 绑定)。"""
from __future__ import annotations

import contextvars
import re
from pathlib import Path

_EXPR_EDIT_INSTRUCTIONS = ('只改变面部表情为威严：下巴微抬（chin raised）、俯视镜头（looking down at viewer）、双眼锐利眯窄（sharp narrowed eyes，禁止 wide eyes/blank）、眉毛明显压低聚拢（eyebrows lowered，眉峰下压）、双唇抿紧紧闭（tight closed mouth，禁止微笑/张嘴）。表情幅度要大、一眼可辨。保持同一人物、同一短发齐下巴、同一雨衣与构图，不要改衣服、不要戴帽、不要加徽章文字、不要加长发、不要改裁切、不要心形瞳孔、不要多眼睛、不要重画瞳孔高光。', '只改变面部表情为冷酷：面无表情（expressionless）、眼神冷、双眼半睁半阖（half-lidded eyes）、眉毛中性不皱不抬（eyebrows neutral）、闭嘴嘴角平直（flat mouth，禁止 frown/smile）、目光冷淡可略偏一侧。表情幅度要大。保持同一人物、同一短发、同一雨衣与构图，不要改衣服、不要戴帽、不要加徽章文字、不要加长发、不要改裁切。', '同一角色、同发型同服装、头肩构图，只改变面部表情为沉思：视线下垂偏一侧（eyes looking down and to one side, not at viewer）、眉头微蹙（brows slightly furrowed / soft knit brows）、嘴唇闭合（lips closed，禁止张嘴、禁止 O 形嘴）；目光低垂偏侧沉思，不要微笑。禁止侧面化、禁止改发型服装构图、不要戴帽、不要加徽章文字、不要加长发。', '同一角色、同发型同服装、头部特写构图，只改变面部表情为温柔：closed-mouth gentle smile, lips together, mouth corners up, soft warm eyes, soft relaxed brows（闭嘴浅笑、抿嘴微笑、眼神柔和，睁眼或弯月眼均可）；眉毛舒展放松（禁止 frown/furrowed），嘴角上扬但双唇闭合、禁止张嘴露齿。禁止嘟嘴撇嘴、禁止改发型服装构图、不要戴帽、不要加徽章文字、不要加长发、不要心形瞳孔、胸口不要入画。', '只改变面部表情为惊恐：双眼瞪大、嘴巴明显张开可见口腔、眉毛高高上扬、眉心分开。必须张嘴。表情幅度要大。保持同一人物、同一短发、同一雨衣与构图，不要改衣服、不要戴帽、不要加徽章文字、不要加长发、不要改裁切、不要裁太近。', '只改变面部表情为果断：determined，firm closed mouth，focused eyes，eyebrows slightly lowered；双唇抿紧闭嘴（坚定，禁止张嘴/喊叫/surprised/open mouth）、禁止挑眉。下颌微绷（正面，勿侧头）。与威严的皱眉下垂嘴角区分，与惊恐张嘴区分。表情幅度要大。保持同一人物、同一短发、同一雨衣与构图，不要改衣服、不要戴帽、不要加徽章文字、不要加长发、不要改裁切。')

_EXPR_INPAINT_PROMPTS = ('same character anime closeup, stern majestic expression, chin raised looking down at viewer, sharp narrowed eyes, eyebrows lowered, tight closed mouth lips pressed, no smile no wide eyes no blank stare, blue-violet iris unchanged, only change eyebrows eyes mouth jaw tilt, keep identical hair length face shape skin tone collar composition, do not redraw pupil highlights', 'same character anime closeup, cold expressionless face, half-lidded eyes, flat mouth, eyebrows neutral, no frown no smile, closed mouth, only change eyebrows eyes mouth, keep identical hair face shape skin tone collar composition', 'same character anime closeup head and shoulders, thoughtful contemplative expression, eyes looking down and to one side, brows slightly furrowed, lips closed no smile, only change expression, keep identical hair face shape skin tone clothing composition, front facing no side view', 'same character anime head closeup, gentle smile, mouth corners up, soft relaxed brows, eyes softly curved, no frown no pout, only change expression, keep identical hair face shape skin tone, no chest in frame', 'same character anime closeup, terrified expression, eyes wide open, mouth wide open showing interior, eyebrows raised high, must open mouth, only change eyebrows eyes mouth, keep identical hair face shape skin tone collar composition', 'same character anime closeup, determined expression, firm closed mouth, focused eyes, eyebrows slightly lowered, no surprised open mouth, no raised brows, jaw slightly tense, front facing, only change eyebrows eyes mouth, keep identical hair face shape skin tone collar composition')

_EXPR_INPAINT_NEGATIVES = ('wide eyes, blank stare, blank expression, smile, grinning, open mouth, raised brows, soft smile', 'frown, smiling, smile, grinning, furrowed brows, angry brows, downturned angry mouth', 'big smile, grinning, wide eyes, raised brows, open mouth, laughing, angry deep scowl, looking straight at camera alert', 'frown, pout, scowling, furrowed brows, downturned mouth, angry brows, neutral expression no smile, blank stare, wide terrified eyes, open mouth scream', 'closed mouth, smile, calm face, sleepy eyes', 'surprised, open mouth, raised brows, screaming, shouting, wide open mouth')

_CHAR_SHEET_MARK = 'char_sheet_'

_CHAR_PANEL_MARK = 'char_panel_'

_POLL_INTERVAL = 2.0

_POLL_TIMEOUT = 420.0

_QUEUE_WAIT_MAX = 1200.0

_QUEUE_WAIT_RETRY_MAX = 3

_MAX_REFS = 8

_FORBIDDEN_WORKER_PORTS = {8195, 8196, 8197, 8205, 8261, 8263}

_SHEET_ALLOWED_PORTS = frozenset({8262, 8264})

_YAW_FACE_APP = None

_FACE_ANGLE_NEGATIVE: dict[str, str] = {'face_front': 'side profile, strict profile, 90 degree profile, three-quarter turn, head turned away, only one eye, silhouette nose, hood up, hood covering hair', 'face_three_quarter': 'front face looking at camera, symmetrical frontal face, both eyes equal, looking at viewer, facing camera, strict side profile, 90 degree profile, full profile silhouette, extreme dutch tilt, head flopped sideways, over-the-shoulder, looking back, hood up, hood covering hair, full body', 'face_side': 'front face, looking at camera, both eyes visible, symmetrical face, frontal view, three-quarter view, face toward camera, two eyes, over-the-shoulder, looking back over shoulder, turned toward viewer, hood up, logo on hood, emblem, badge, abstract circle face, stylized mark, symbol instead of face, blank hood, full body, waist up standing'}

_SHEET_CKPT = {'ancient_realistic': 'DreamShaper_8_pruned.safetensors', 'anime': 'animagineXL40.safetensors'}

_THEME = {'ancient_realistic': {'bg': (11, 14, 20, 255), 'text': (212, 175, 55), 'text_muted': (168, 140, 70), 'text_dim': (120, 100, 55), 'outline': (90, 75, 40), 'name_bg': (20, 24, 32, 255), 'title_bar': (8, 10, 14, 255), 'title_text': (212, 175, 55), 'scale': (180, 150, 70)}, 'anime': {'bg': (248, 248, 252, 255), 'text': (30, 30, 36), 'text_muted': (90, 90, 100), 'text_dim': (120, 120, 130), 'outline': (200, 200, 210), 'name_bg': (40, 40, 48, 255), 'title_bar': (40, 40, 48, 255), 'title_text': (230, 230, 235), 'scale': (80, 80, 90)}}

_CJK_FONT_CANDIDATES = ('/System/Library/Fonts/STHeiti Light.ttc', '/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc', '/Library/Fonts/Arial Unicode.ttf', str(Path.home() / 'Library/Fonts/SimSun-Regular.ttf'), str(Path.home() / 'Library/Fonts/SourceHanSansSC-Regular.otf'), '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc', '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/arphic/uming.ttc', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', '/usr/share/fonts/truetype/source-han-sans/SourceHanSansSC-Regular.otf')

_COSTUME_ITEMS: tuple[tuple[str, str], ...] = (('raincoat', 'product still life, single object only, one complete matte slate-gray hooded raincoat garment laid flat open on table like e-commerce flat lay, attached hood at collar, two long sleeves spread left and right, full torso, front zipper, entire garment mid-tone slate gray nylon #5A6A7A, plain unbranded no logo no emblem no chest patch, no jet black, no pure black panels, no white panels, no navy panels, fills most of frame, solid seamless pure white background, studio lighting, no person, no face, no mannequin, no worn clothes, no white t-shirt, no hoodie, no cloak, no cape, no poncho, no beige, no brown, no tan, no khaki, no red, no text, no brand'), ('pants', 'product still life, single object only, ONE single pair of long black trousers, full length to ankles, one item only, exactly one waistband and two long pant legs, laid flat fully visible side by side, matte jet-black fabric, clothing flat lay catalog photo, fills most of frame, solid seamless pure white background, studio lighting, no person, no face, no body, no mannequin, no shorts, no short pants, no bermuda, no cropped pants, no knee-length, no skirt, no multiple pairs, no repeated pants, no row of pants, no four pants, no collage of pants, no grid of trousers, no navy, no blue, no grey, no beige, no brown, no cloak, no text'), ('boots', 'product still life, single object only, one pair (exactly two) glossy jet-black rubber rain boots standing side by side, footwear only, empty boots, pure black rubber, fills most of frame, solid seamless pure white background, studio lighting, no person, no face, no body, no mannequin, no legs, no feet inside, no many boots, no row of boots, no repeated boots, no multiple pairs, no five boots, no six boots, no line of boots, no collage of footwear, no sandals, no text, no debris'), ('umbrella', 'product still life, single object only, one open clear transparent rain umbrella with visible ribs and handle, with thin black ribs and black shaft handle, see-through vinyl canopy, solid seamless pure light gray background, studio lighting, no person, no face, no hat, no cap, no lamp, no opaque canopy, no solid black dome, no white canopy, no colored canopy, no cloak, no text'), ('bag', 'product still life, single object only, one plain opaque white plastic shopping bag with two handles, empty, slightly crinkled white polyethylene, solid seamless pure light gray background, studio lighting, no person, no face, no blue bag, no tote canvas, no logo, no text, no chinese, no cloak'))

_COSTUME_ITEMS_ANCIENT: tuple[tuple[str, str], ...] = (('beizi', 'e-commerce flat lay product photo, garment only, ONE traditional Chinese beizi outer robe laid flat open on table, jet black silk with gold trim and gold embroidery, black-and-gold colorway only, long wide sleeves spread left and right, no body inside, empty garment shape, fills most of frame, solid seamless medium light gray background (#C8C8CE), studio softbox, no person, no face, no hands, no mannequin, no model wearing clothes, no half body portrait, no raincoat, no modern jacket, no red, no crimson, no scarlet, no vermilion, no orange robe, no text'), ('jiaoling', 'e-commerce flat lay product photo, garment only, ONE traditional Chinese cross-collar jiaoling robe laid flat open like clothing catalog, dark silk, wide sleeves, no body inside, empty garment, fills most of frame, solid seamless medium light gray background (#C8C8CE), studio lighting, no person, no face, no mannequin, no worn clothes, no hoodie, no zipper, no text'), ('sash', 'product still life flat lay, accessory only, ONE wide silk waist sash belt for hanfu, dark embroidered ribbon coiled neatly on table, no person wearing it, solid seamless medium light gray background (#C8C8CE), studio lighting, no person, no waist, no text'), ('hairpin', 'product still life, accessory only, ONE ornate Chinese hairpin zan with jade tip, metal and jade isolated on table, catalog photo, solid seamless medium light gray background (#C8C8CE), studio lighting, no person, no hair, no head, no face, no text'), ('fan', 'product still life, accessory only, ONE round silk tuanshan hand fan, ink painting motif, wooden handle, isolated object, solid seamless medium light gray background (#C8C8CE), studio lighting, no person, no hand holding, no umbrella, no plastic, no text'))

_COSTUME_FORCE = 'overhead flat lay product photography, garments and props laid flat on table, ONLY these five items: ONE slate-gray hooded raincoat, ONE pair full-length black long pants (not shorts), ONE pair black rain boots, ONE clear transparent rain umbrella with shaft and handle (not a lamp, not a hat), ONE white plastic shopping bag, slate gray raincoat plus black pants/boots, clothing pieces arranged neatly as product shots, isolated on solid seamless background, no person, no face, no mannequin, no model wearing clothes, no hanging rack display, no color variants, no hanfu, no ancient costume, no white robe, no white jacket, no white coat, no beige jacket, no blue jacket, no red cloak, no beige cloak, no brown cloak, fashion design sheet'

_COSTUME_ITEM_NEGATIVE: dict[str, str] = {'pants': 'shorts, short pants, bermuda, cropped pants, knee-length pants, skirt, multiple pairs, repeated pants, row of pants, many pants, four pants, collage of pants, grid of trousers, split screen pants, duplicate trousers, empty panel, empty slot, UI mockup, wireframe box, rectangular frame, interface layout, three empty boxes, catalog UI', 'boots': 'many boots, row of boots, repeated boots, multiple pairs, five boots, six boots, four boots, three boots, line of boots, collage of footwear, duplicate rain boots, crowd of boots, shelf of boots, more than two boots'}

_SHEET_REJECT_CTX: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar('toiv_sheet_reject_ctx', default=None)

_ANCIENT_COLOR_MAP: tuple[tuple[str, str, str, str, str], ...] = (('藏青', 'navy blue', 'zangqing', 'dark navy', '#233A5E'), ('天青', 'celadon sky blue', 'tianqing', 'pale blue celadon', '#8FBCC8'), ('竹青', 'bamboo green teal', 'zhuqing', 'teal green', '#3C8C78'), ('青绿', 'teal green', 'qinglv', 'teal green', '#3C8C78'), ('月白', 'pale moon white', 'yuebai', 'very pale blue white', '#D6E4EA'), ('鹅黄', 'pale goose yellow', 'ehuang', 'light yellow', '#F0DC82'), ('胭脂', 'rouge red', 'yanzhi', 'carmine red', '#B03A48'), ('朱红', 'vermilion red', 'zhuhong', 'vermilion', '#C83C23'), ('绯', 'crimson red', 'feise', 'crimson', '#B83A3A'), ('青', 'teal', 'qingse', 'cyan teal', '#3A8C8C'), ('碧', 'jade green', 'bise', 'jade green', '#3FA58A'), ('绿', 'green', 'lvse', 'soft green', '#4A8A4A'), ('蓝', 'blue', 'lanse', 'soft blue', '#3A5F9A'), ('红', 'red', 'hongse', 'red', '#B03030'), ('粉', 'pink', 'fense', 'soft pink', '#E8A0B0'), ('紫', 'purple', 'zise', 'lavender purple', '#7A4E9A'), ('黄', 'yellow', 'huangse', 'yellow', '#E0C050'), ('橙', 'orange', 'chengse', 'orange', '#D8823A'), ('褐', 'brown', 'hese', 'brown', '#7A5434'), ('棕', 'brown', 'zongse', 'brown', '#7A5434'), ('灰', 'gray', 'huise', 'gray', '#8A8A8E'), ('白', 'white', 'baise', 'white', '#EDEDE8'), ('玄', 'black', 'xuanse', 'black', '#1A1A1E'), ('黑', 'black', 'heise', 'black', '#1A1A1E'), ('金', 'gold', 'jinse', 'golden', '#D4AF37'))

_ANCIENT_GARMENT_NOUNS = '衣裙袍衫襦袄裳褂服纱罗绸锦缎帔氅装褙'

_ANCIENT_GARMENT_EN: tuple[tuple[str, str], ...] = (('襦裙', 'ruqun dress'), ('衣裙', 'ruqun dress'), ('褙子', 'beizi robe'), ('长袍', 'robe'), ('袍', 'robe'), ('裙', 'ruqun dress'), ('衫', 'shan blouse'), ('袄', 'ao jacket'))

_ANCIENT_ACCESSORY_MAP: tuple[tuple[str, str, bool], ...] = (('木簪', '(wooden hairpin:1.2)', True), ('玉簪', '(jade hairpin:1.2)', True), ('银簪', '(silver hairpin:1.2)', True), ('金簪', '(gold hairpin:1.2)', True), ('步摇', '(buyao dangling hairpin:1.1)', True), ('簪', '(simple hairpin:1.1)', True), ('发带', '(ribbon hair band:1.1)', True), ('油纸伞', '(oil-paper umbrella:1.2), chinese paper parasol', False), ('纸伞', '(oil-paper umbrella:1.2), chinese paper parasol', False), ('伞', '(chinese paper umbrella:1.1)', False), ('团扇', '(round silk fan:1.1)', False), ('折扇', '(folding fan:1.1)', False), ('药箱', '(wooden medicine box:1.1)', False), ('药篓', '(bamboo herb basket:1.1)', False), ('玉佩', '(jade pendant:1.1)', False), ('香囊', '(embroidered sachet:1.1)', False), ('面纱', '(thin face veil:1.1)', False), ('斗笠', '(bamboo hat:1.1)', False))

_ANCIENT_HAIR_MAP: tuple[tuple[str, str], ...] = (('双髻', 'double hair buns'), ('低髻', 'low hair bun'), ('发髻', 'hair bun'), ('髻', 'hair bun'), ('马尾', 'long ponytail'), ('披发', 'loose long black hair'), ('垂鬟', 'half-up hairstyle'), ('长发', 'long black hair'), ('短发', 'short black hair'))

_ANCIENT_ROLE_MAP: tuple[tuple[str, str], ...] = (('医女', 'herbalist physician girl'), ('大夫', 'herbalist physician'), ('江南', 'jiangnan water town maiden'))

_ANCIENT_BLACK_GOLD_NEGATIVE = 'black robe, black clothing, black hanfu, gold trim, gold embroidery, gold hair ornament, gold headdress, golden crown, ornate gold hairpin'

_CJK_RUN_RE = re.compile('[\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef]+')

_ANCIENT_SPEC_NEG_CTX: contextvars.ContextVar[str] = contextvars.ContextVar('toiv_ancient_spec_neg', default='')

_ANCIENT_GOLD_HEX = '#D4AF37'

_ANCIENT_ACCESSORY_HEX: tuple[tuple[str, str], ...] = (('木簪', '#A0764A'), ('玉簪', '#9FC8A8'), ('银簪', '#C0C0C8'), ('金簪', '#D4AF37'), ('油纸伞', '#E6D8B8'), ('纸伞', '#E6D8B8'), ('药箱', '#8B6A44'), ('药篓', '#B89A6A'))

_ANCIENT_UMBRELLA_HELD_POS = '(closed oil-paper umbrella held in her hand by the bamboo handle:1.2), umbrella handle gripped in hand'

_ANCIENT_UMBRELLA_HELD_NEG = 'floating umbrella, umbrella floating behind head, umbrella as halo, detached umbrella, umbrella not held, umbrella attached to hair'

_EXPR_GRID_EDIT_INSTRUCTION = '这是一张 2 行×3 列的角色近景头像宫格。只改每一格的眉毛、眼睛、嘴巴，做出六种明显不同的表情；不要改发型、脸型、肤色、领口、肩线、构图与背景；从左到右、从上到下依次为：威严（眉头下压、嘴角下压）、冷酷（半睁斜视、嘴平）、沉思（视线下垂、眉轻蹙）、温柔（眉放松带微笑）、惊恐（双眼瞪大、嘴巴明显张开）、果断（眉压低、双唇抿紧闭嘴）。每格保持同一人物、同一短发齐下巴、同一雨衣领口与配色；不要加文字、徽标、徽章、水印；不要加长发；不要把六格融成一张脸；六格眉眼嘴变化要大、一眼可辨，尤其惊恐必须张嘴。'

_DELOGO_DENOISE_SCHEDULE = (0.28, 0.45, 0.6)

_EXPR_QA_PROMPTS: dict[str, str] = {'expr_2': 'You are inspecting an anime character head closeup for a CONTEMPLATIVE (沉思) expression. Answer TWO yes/no questions. Output ONLY one JSON object, no markdown: {"q1":true,"q2":true}. q1: Is the mouth CLOSED (lips together)? Answer false if the mouth is open at all, including an O-shaped or round open mouth, visible teeth or a gap between the lips. q2: Does the face read as contemplative: gaze directed DOWNWARD or down-to-the-side (视线下垂偏一侧 / looking down and to one side) (not staring blankly at the viewer), brows slightly knit/furrowed, no smile? Answer false for a blank empty stare, surprise, or smiling. Judge only from visible face features.', 'expr_3': 'You are inspecting an anime character head closeup for a GENTLE (温柔) expression. Answer TWO yes/no questions. Output ONLY one JSON object, no markdown: {"q1":true,"q2":true}. q1: Is the mouth CLOSED with a slight smile (lips together, mouth corners up)? Answer false if the mouth is open, O-shaped, showing teeth, or not smiling. q2: Does the face read as gentle: soft warm eyes (open eyes or 弯月眼 crescent eyes both OK; closed eyes NOT required), relaxed brows, no frown, no blank stare? Judge only from visible face features.', 'mouth_zoom': 'This image is a ZOOMED crop of the mouth area of an anime character. Answer TWO yes/no questions. Output ONLY one JSON object, no markdown: {"q1":true,"q2":true}. q1: Are the lips FULLY CLOSED, drawn as a single line or a closed curve, with NO opening? Answer false if there is ANY visible gap, small oval or round opening, dark or red mouth interior, tongue or teeth, however small. q2: Is a mouth clearly visible in this crop? Judge only from what is visible.'}

_EXPR_VLM_LABEL_TO_KEY = {'威严': 'expr_0', '冷酷': 'expr_1', '沉思': 'expr_2', '温柔': 'expr_3', '惊恐': 'expr_4', '果断': 'expr_5'}

_EXPR_KEY_TO_VLM_LABEL = {v: k for k, v in _EXPR_VLM_LABEL_TO_KEY.items()}

_EXPR_VLM_PROMPT = 'You are an expression classifier for anime character closeups. Choose exactly ONE label from: 威严, 冷酷, 沉思, 温柔, 惊恐, 果断. Also answer the yes/no second question: is the face smiling (mouth corners up OR soft closed-eye smile)? Output ONLY one JSON object, no markdown, no extra text. Schema: {"label":"<one of six>","scores":{"威严":0,"冷酷":0,"沉思":0,"温柔":0,"惊恐":0,"果断":0},"smiling":true}. smiling must be a boolean: true if mouth corners raised or soft smile / crescent eyes, else false. Fill scores with your confidences (0~1, roughly normalized). Do NOT copy any example; judge from the actual face in the image. Visible-feature definitions (must match what you see, not just the name): 威严=chin raised + looking down at viewer + sharp narrowed eyes + eyebrows lowered + tight closed mouth (reject if wide eyes or blank stare); 冷酷=expressionless + half-lidded eyes + flat mouth + eyebrows neutral (reject if frown or smile); 沉思=eyes looking down and to one side + brows slightly furrowed (soft knit) + lips closed + faraway gaze (reject if smile or open mouth or looking straight alert); 温柔=relaxed brows + gentle smile with mouth corners up + eyes softly curved (open or crescent OK, closed OK); reject if no smile / frown; for 温柔, smiling MUST be true; 惊恐=wide eyes + open mouth; 果断=focused eyes + firm closed mouth + brows slightly lowered.'

_VLM_STICKY_BACKEND: tuple[str, str] | None = None

_VLM_STICKY_EVIDENCE: dict[str, Any] = {'keep_model_loaded': True, 'sticky_hits': 0, 'sticky_misses': 0, 'last_backend': None, 'last_model': None}

_ANIME_CASCADE = None

_COSTUME_PORTRAIT_BANDS: tuple[tuple[str, tuple[float, float, float, float]], ...] = (('collar', (0.34, 0.18, 0.66, 0.34)), ('cuff', (0.0, 0.42, 0.38, 0.58)), ('hem', (0.3, 0.62, 0.7, 0.78)), ('boots', (0.38, 0.82, 0.62, 0.995)))

_COSTUME_PORTRAIT_N = 4

_COSTUME_MIN_EDGE_DENSITY = 0.01

_OPENPOSE_FRONT: list[tuple[float, float]] = [(0.5, 0.06), (0.5, 0.12), (0.38, 0.14), (0.3, 0.28), (0.28, 0.4), (0.62, 0.14), (0.7, 0.28), (0.72, 0.4), (0.44, 0.42), (0.42, 0.66), (0.42, 0.92), (0.56, 0.42), (0.58, 0.66), (0.58, 0.92), (0.46, 0.05), (0.54, 0.05), (0.44, 0.06), (0.56, 0.06)]

_OPENPOSE_SIDE: list[tuple[float, float]] = [(0.58, 0.06), (0.52, 0.12), (0.5, 0.14), (0.48, 0.3), (0.46, 0.42), (0.54, 0.14), (0.56, 0.3), (0.58, 0.42), (0.5, 0.42), (0.5, 0.66), (0.5, 0.92), (0.52, 0.42), (0.52, 0.66), (0.52, 0.92), (0.6, 0.05), (0.56, 0.05), (0.48, 0.06), (0.62, 0.06)]

_OPENPOSE_BACK: list[tuple[float, float]] = [(0.5, 0.07), (0.5, 0.12), (0.62, 0.14), (0.7, 0.28), (0.72, 0.4), (0.38, 0.14), (0.3, 0.28), (0.28, 0.4), (0.56, 0.42), (0.58, 0.66), (0.58, 0.92), (0.44, 0.42), (0.42, 0.66), (0.42, 0.92), (0.54, 0.05), (0.46, 0.05), (0.56, 0.06), (0.44, 0.06)]

_OPENPOSE_LIMBS: list[tuple[int, int, tuple[int, int, int]]] = [(1, 2, (255, 0, 0)), (1, 5, (0, 255, 0)), (2, 3, (255, 85, 0)), (3, 4, (255, 170, 0)), (5, 6, (0, 255, 85)), (6, 7, (0, 255, 170)), (1, 8, (170, 0, 255)), (1, 11, (255, 0, 170)), (8, 9, (85, 0, 255)), (9, 10, (0, 85, 255)), (11, 12, (0, 170, 255)), (12, 13, (0, 255, 255)), (0, 1, (255, 0, 85))]

_OPENPOSE_FACE_FRONT: list[tuple[float, float]] = [(0.5, 0.28), (0.5, 0.42), (0.28, 0.48), (0.18, 0.72), (0.14, 0.92), (0.72, 0.48), (0.82, 0.72), (0.86, 0.92), (0.38, 0.95), (0.38, 0.98), (0.38, 0.99), (0.62, 0.95), (0.62, 0.98), (0.62, 0.99), (0.4, 0.24), (0.6, 0.24), (0.3, 0.3), (0.7, 0.3)]

_OPENPOSE_FACE_THREE_QUARTER: list[tuple[float, float]] = [(0.38, 0.3), (0.48, 0.42), (0.34, 0.5), (0.28, 0.74), (0.24, 0.92), (0.7, 0.48), (0.82, 0.72), (0.86, 0.92), (0.42, 0.95), (0.42, 0.98), (0.42, 0.99), (0.62, 0.95), (0.62, 0.98), (0.62, 0.99), (0.3, 0.26), (0.48, 0.24), (0.22, 0.32), (0.62, 0.28)]

_OPENPOSE_FACE_SIDE: list[tuple[float, float]] = [(0.28, 0.32), (0.48, 0.42), (0.46, 0.5), (0.44, 0.74), (0.42, 0.92), (0.52, 0.5), (0.54, 0.74), (0.56, 0.92), (0.48, 0.95), (0.48, 0.98), (0.48, 0.99), (0.52, 0.95), (0.52, 0.98), (0.52, 0.99), (0.34, 0.28), (0.34, 0.28), (0.58, 0.3), (0.58, 0.3)]
