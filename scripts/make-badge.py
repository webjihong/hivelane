import math, struct, zlib, sys
# 아이콘 모양(512 좌표)을 흰색 실루엣 + 투명 배경으로. 안드로이드 배지는 알파만 쓴다.
def hexagon(cx, cy, r):  # 꼭짓점 위·아래 (아이콘과 같은 방향)
    return [(cx + r*math.sin(math.radians(a)), cy - r*math.cos(math.radians(a))) for a in range(0, 360, 60)]
def inside(pt, poly):
    x, y = pt; n = len(poly); c = False
    for i in range(n):
        x1, y1 = poly[i]; x2, y2 = poly[(i+1) % n]
        if (y1 > y) != (y2 > y) and x < (x2-x1)*(y-y1)/(y2-y1) + x1: c = not c
    return c
def seg_dist(p, a, b):
    px, py = p; ax, ay = a; bx, by = b
    dx, dy = bx-ax, by-ay; t = max(0, min(1, ((px-ax)*dx + (py-ay)*dy) / (dx*dx+dy*dy)))
    return math.hypot(px-(ax+t*dx), py-(ay+t*dy))
def quad(p0, p1, p2, n=12):
    return [((1-t)**2*p0[0]+2*(1-t)*t*p1[0]+t*t*p2[0], (1-t)**2*p0[1]+2*(1-t)*t*p1[1]+t*t*p2[1]) for t in [i/n for i in range(n+1)]]
outer_o = hexagon(256, 256, 164+16); outer_i = hexagon(256, 256, 164-16)   # 바깥 육각 테두리
core = hexagon(256, 256, 86)                                                  # 안쪽 몸통
stripes = [(200, 230, 312, 250), (200, 268, 312, 288)]                        # 몸통 줄무늬(비움)
ant = [quad((232,168),(222,140),(180,128)), quad((280,168),(290,140),(332,128))]  # 더듬이
def on(x, y):
    if inside((x,y), outer_o) and not inside((x,y), outer_i): return True
    if inside((x,y), core) and not any(a<=x<=c and b<=y<=d for a,b,c,d in stripes): return True
    for pts in ant:
        if any(seg_dist((x,y), pts[i], pts[i+1]) <= 11 for i in range(len(pts)-1)): return True
    return False
def render(size, out):
    x0, y0, span = 56, 56, 400   # 512 중 가운데 영역을 꽉 차게
    ss = 4; rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            hit = sum(on(x0 + (px + (i+.5)/ss)*span/size, y0 + (py + (j+.5)/ss)*span/size) for i in range(ss) for j in range(ss))
            row += bytes([255, 255, 255, round(255*hit/(ss*ss))])
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t+d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(out, 'wb').write(png)
render(96, sys.argv[1])
