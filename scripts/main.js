const TAG = "[line-bridge]";
const PREF_ON = "linebridge-enabled";

const cur1e = require("cur1e-shared");

const INT = java.lang.Integer.TYPE, FLOAT = java.lang.Float.TYPE;
let mUpdateLine, mTileX, fLineRot, fPlanTree = null;
try{
    const IH = java.lang.Class.forName("mindustry.input.InputHandler");
    mUpdateLine = IH.getDeclaredMethod("updateLine", INT, INT, INT, INT);
    mUpdateLine.setAccessible(true);
    mTileX = [IH.getDeclaredMethod("tileX", FLOAT), IH.getDeclaredMethod("tileY", FLOAT)];
    mTileX[0].setAccessible(true);
    mTileX[1].setAccessible(true);
    fLineRot = java.lang.Class.forName("mindustry.input.InputHandler$PlaceLine").getDeclaredField("rotation");
    fLineRot.setAccessible(true);
    try{
        fPlanTree = IH.getDeclaredField("playerPlanTree");
        fPlanTree.setAccessible(true);
    }catch(e){
        Log.warn(TAG + " no playerPlanTree, scanning the whole queue: " + e);
        fPlanTree = null;
    }
}catch(e){
    Log.err(TAG + " init failed, mod disabled: " + e);
    mUpdateLine = null;
}

const ConstructBuild = ConstructBlock.ConstructBuild;
const ChainedBuilding = Packages.mindustry.world.blocks.distribution.ChainedBuilding;

let errors = 0;
function report(e){
    errors++;
    if(errors == 1){
        Log.err(TAG + " line calculation failed, vanilla line used instead (further errors are not logged): " + e
            + (e.javaException ? "\n" + Strings.getStackTrace(e.javaException) : "")
            + (e.stack ? "\n" + e.stack : ""));
    }
}

const I = v => new java.lang.Integer(v);

function updateLine(inp, x1, y1, x2, y2, replace){
    if(replace){
        mUpdateLine.invoke(inp, I(x1), I(y1), I(x2), I(y2));
        return;
    }
    const rot = inp.rotation, lineRot = fLineRot.getInt(inp.line);
    Core.settings.put("blockreplace", false);
    try{
        mUpdateLine.invoke(inp, I(x1), I(y1), I(x2), I(y2));
    }finally{
        Core.settings.put("blockreplace", true);
        inp.rotation = rot;
        fLineRot.setInt(inp.line, lineRot);
    }
}

function unitPlans(unit){
    const p = unit.plans;
    return typeof p === "function" ? unit.plans() : p;
}

const treeOut = new Seq(), tileRect = new Rect();

function planCovering(list, x, y){
    for(let i = 0; i < list.size; i++){
        let q = list.get(i);
        if(q.breaking || q.block == null) continue;
        let s = q.block.size, x0 = q.x - Math.floor((s - 1) / 2), y0 = q.y - Math.floor((s - 1) / 2);
        if(x >= x0 && x < x0 + s && y >= y0 && y < y0 + s) return q;
    }
    return null;
}

function obstacles(inp){
    const unit = Vars.player.unit();
    const team = Vars.player.team();
    const plans = unit == null ? null : unitPlans(unit);
    const tree = plans == null || plans.size == 0 || fPlanTree == null ? null : fPlanTree.get(inp);
    let all = null;
    if(plans != null && plans.size > 0 && tree == null){
        all = Object.create(null);
        plans.each(cons(q => {
            if(q.breaking || q.block == null) return;
            const s = q.block.size, off = -Math.floor((s - 1) / 2);
            for(let dx = 0; dx < s; dx++){
                for(let dy = 0; dy < s; dy++) all[Point2.pack(q.x + off + dx, q.y + off + dy)] = q;
            }
        }));
    }
    const cache = Object.create(null);
    return {
        at(x, y){
            const key = Point2.pack(x, y);
            const c = cache[key];
            if(c !== undefined) return c;
            let o = null;
            let q = null;
            if(tree != null){
                treeOut.clear();
                tree.intersect(tileRect.setCentered(x * Vars.tilesize, y * Vars.tilesize, 2), treeOut);
                if(treeOut.size > 0) q = planCovering(treeOut, x, y);
            }else if(all != null){
                q = all[key] || null;
            }
            if(q != null){
                o = {block: q.block, rotation: q.rotation, plan: q, site: null};
            }else{
                const tile = Vars.world.tile(x, y);
                const b = tile == null ? null : tile.build;
                if(b instanceof ConstructBuild && b.wasConstructing && b.current != null && b.team == team){
                    o = {block: b.current, rotation: b.rotation, plan: null, site: b};
                }
            }
            cache[key] = o;
            return o;
        }
    };
}

function lineFamily(block){
    if(block instanceof Conveyor){
        const br = block.bridgeReplacement;
        return {
            cls: Conveyor, junctionCls: Junction,
            junction: block.junctionReplacement,
            bridge: br instanceof DuctBridge || br instanceof ItemBridge ? br : null,
            hasJunction: block.junctionReplacement != null,
            avoid: br instanceof DuctBridge ? (b => b instanceof Duct || b instanceof Conveyor) : (b => b instanceof Conveyor)
        };
    }
    if(block instanceof Duct){
        const j = block.junctionReplacement, br = block.bridgeReplacement;
        const hasJ = j != null && j.unlockedNow() && !j.isHidden();
        return {
            cls: Duct, junctionCls: DuctJunction,
            junction: hasJ ? j : null,
            bridge: br instanceof DuctBridge || br instanceof ItemBridge ? br : null,
            hasJunction: hasJ,
            avoid: b => b instanceof Duct || b instanceof StackConveyor || b instanceof Conveyor
        };
    }
    if(block instanceof Conduit){
        const br = block.bridgeReplacement == null ? null
            : block.rotBridgeReplacement instanceof DirectionBridge ? block.rotBridgeReplacement : block.bridgeReplacement;
        return {
            cls: Conduit, junctionCls: LiquidJunction,
            junction: block.junctionReplacement,
            bridge: br,
            hasJunction: true,
            avoid: b => b instanceof Conduit
        };
    }
    return null;
}

function processLine(inp, fam, obs){
    const plans = inp.linePlans;
    const team = Vars.player.team();

    const eff = p => {
        const o = obs.at(p.x, p.y);
        if(o != null) return o;
        const t = p.tile();
        return t == null ? null : {block: t.block(), rotation: t.build == null ? 0 : t.build.rotation, plan: null, site: null};
    };

    if(fam.junction != null){
        plans.each(cons(req => {
            const cont = d => plans.contains(boolf(o => o.x == req.x + d.x && o.y == req.y + d.y
                && (req.block instanceof fam.cls || req.block instanceof fam.junctionCls)));
            const e = req.tile() == null ? null : eff(req);
            if(e != null && cont(Geometry.d4[Mathf.mod(req.rotation, 4)]) && cont(Geometry.d4[Mathf.mod(req.rotation - 2, 4)])
                && e.block instanceof fam.cls && Mathf.mod(e.rotation - req.rotation, 2) == 1
                && e.site == null
                && fam.junction.unlockedNow()){
                req.block = fam.junction;
            }
        }));
    }

    const bridge = fam.bridge;
    if(bridge == null || plans.size == 0 || Placement.isSidePlace(plans)) return;
    if(!(plans.first().x == plans.peek().x || plans.first().y == plans.peek().y) || !bridge.unlockedNow()) return;

    const first = plans.first();
    const placeable = p => {
        const t = p.tile();
        if(!(p.placeable(team) || (t != null && t.block() == p.block))) return false;
        const o = obs.at(p.x, p.y);
        if(o != null && o.plan != null && !(p.block.canReplace(o.block) && o.plan.x == p.x && o.plan.y == p.y)) return false;
        if(p == first) return true;
        if(o != null) return !(o.rotation != p.rotation && fam.avoid(o.block));
        return !(p.build() != null && p.build().rotation != p.rotation && fam.avoid(t.block()));
    };
    const needJunction = p => {
        if(!fam.hasJunction) return false;
        const t = p.tile();
        if(t == null) return true;
        const o = obs.at(p.x, p.y);
        if(o == null) return fam.avoid(t.block());
        if(o.site != null || !fam.avoid(o.block)) return false;
        return fam.junction == null || (fam.junction.canReplace(o.block) && o.plan.x == p.x && o.plan.y == p.y);
    };

    const conveyorCost = 3, junctionCost = 30, bridgeCost = 200, bridgeOverEmptyPenalty = 5, infCost = 1073741823;
    const N = plans.size, dp = [], parent = [];
    for(let i = 0; i < 2 * N; i++){
        dp.push(infCost);
        parent.push(-1);
    }
    dp[0] = 0;
    dp[N] = bridgeCost;
    const canPlaceAt = [];
    for(let i = 0; i < N; i++) canPlaceAt.push(placeable(plans.get(i)));

    for(let i = 1; i < N; i++){
        let cur = plans.get(i);
        let canPlace = canPlaceAt[i];
        let junction = needJunction(cur);
        if(!canPlace && !junction) continue;

        dp[i] = dp[i - 1] + (canPlace ? conveyorCost : junctionCost);
        parent[i] = i - 1;

        if(dp[i] < infCost && canPlace){
            dp[N + i] = dp[i] + bridgeCost;
            parent[N + i] = i - 1;
        }

        if(i >= 2 && canPlace){
            let emptyPenalty = 0;
            if(canPlaceAt[i - 1]) emptyPenalty += bridgeOverEmptyPenalty;
            for(let j = i - 2; j >= 0; j--){
                let other = plans.get(j);
                if(!bridge.positionsValid(cur.x, cur.y, other.x, other.y)) break;
                if(canPlaceAt[j]){
                    let cost = dp[N + j] + bridgeCost + emptyPenalty;
                    if(dp[N + i] > cost){
                        dp[N + i] = cost;
                        parent[N + i] = j;
                    }
                    emptyPenalty += bridgeOverEmptyPenalty;
                }
            }
        }

        if(dp[N + i] < dp[i]){
            dp[i] = dp[N + i];
            parent[i] = parent[N + i];
        }

        if(canPlace && dp[i] >= infCost){
            dp[i] = 0;
            dp[N + i] = bridgeCost;
        }
    }

    const result = new Seq();
    let bridgeMode = 0;
    for(let i = N - 1; i >= 0; ){
        let cur = plans.get(i);
        let p = parent[bridgeMode + i];
        if(p == -1 || p == i - 1){
            result.add(cur);
            bridgeMode = 0;
            i--;
        }else{
            let other = plans.get(p);
            cur.block = bridge;
            other.block = bridge;
            if(bridge instanceof ItemBridge) other.config = new Point2(cur.x - other.x, cur.y - other.y);
            result.add(cur);
            i = p;
            bridgeMode = N;
        }
    }
    result.reverse();
    plans.set(result);
}

function relativeTo(x, y, cx, cy){
    if(x == cx && y == cy - 1) return 1;
    if(x == cx && y == cy + 1) return 3;
    if(x == cx - 1 && y == cy) return 0;
    if(x == cx + 1 && y == cy) return 2;
    return -1;
}

function astar(block, obs, startX, startY, endX, endY){
    const world = Vars.world;
    const start = world.tile(startX, startY), end = world.tile(endX, endY);
    if(start == end || start == null || end == null) return null;
    const blockAt = t => {
        const o = obs.at(t.x, t.y);
        return o != null && o.plan != null ? o.block : t.block();
    };
    const validNode = other => {
        const b = blockAt(other);
        return block.canReplace(b) || b.alwaysReplace;
    };
    const costs = new IntFloatMap(), parents = new IntIntMap(), closed = new IntSet();
    const tileHeuristic = (tile, other) => {
        const b = blockAt(other);
        if((!b.alwaysReplace && !block.canReplace(b)) || other.floor().isDeep()) return 20;
        if(parents.containsKey(tile.pos())){
            const prev = world.tile(parents.get(tile.pos(), 0));
            if(relativeTo(tile.x, tile.y, prev.x, prev.y) != relativeTo(other.x, other.y, tile.x, tile.y)) return 8;
        }
        return 1;
    };
    const dist = (x1, y1, x2, y2) => Math.abs(x1 - x2) + Math.abs(y1 - y2);
    const queue = new PQueue(10, new java.util.Comparator({
        compare: (a, b) => java.lang.Float.compare(
            costs.get(a.pos(), 0) + dist(a.x, a.y, end.x, end.y),
            costs.get(b.pos(), 0) + dist(b.x, b.y, end.x, end.y))
    }));
    const nodeLimit = 1000;
    let totalNodes = 0, found = false;
    queue.add(start);
    while(!queue.empty() && totalNodes++ < nodeLimit){
        let next = queue.poll();
        let baseCost = costs.get(next.pos(), 0);
        if(next == end){
            found = true;
            break;
        }
        closed.add(Point2.pack(next.x, next.y));
        for(let d = 0; d < 4; d++){
            let point = Geometry.d4[d];
            let child = world.tile(next.x + point.x, next.y + point.y);
            if(child != null && validNode(child)){
                if(closed.add(child.pos())){
                    parents.put(child.pos(), next.pos());
                    costs.put(child.pos(), new java.lang.Float(tileHeuristic(next, child) + baseCost));
                    queue.add(child);
                }
            }
        }
    }
    if(!found) return null;
    const out = [{x: endX, y: endY}];
    let total = 0, current = end;
    while(current != start && total++ < nodeLimit){
        if(current == null) return null;
        let newPos = parents.get(current.pos(), -1);
        if(newPos == -1) return null;
        out.push({x: Point2.x(newPos), y: Point2.y(newPos)});
        current = world.tile(newPos);
    }
    out.reverse();
    return out;
}

function seqPoints(pts){
    const out = [];
    for(let i = 0; i < pts.size; i++){
        let p = pts.get(i);
        out.push({x: p.x, y: p.y});
    }
    return out;
}

function rawPoints(block, sx, sy, ex, ey, obs){
    let diagonal = Core.input.keyDown(Binding.diagonalPlacement);
    if(block.swapDiagonalPlacement) diagonal = !diagonal;
    const start = Vars.world.build(sx, sy), end = Vars.world.build(ex, ey);
    let pts = null;
    if(diagonal && block.allowDiagonal){
        if(start instanceof ChainedBuilding && end instanceof ChainedBuilding && block.canReplace(end.block) && block.canReplace(start.block)){
            pts = seqPoints(Placement.upgradeLine(sx, sy, ex, ey));
        }else if(obs != null && block.conveyorPlacement && Core.settings.getBool("conveyorpathfinding")){
            pts = astar(block, obs, sx, sy, ex, ey);
            if(pts == null) pts = seqPoints(Placement.normalizeLine(sx, sy, ex, ey));
        }else{
            pts = seqPoints(Placement.pathfindLine(block.conveyorPlacement, sx, sy, ex, ey));
        }
    }else if(block.allowRectanglePlacement){
        pts = seqPoints(Placement.normalizeRectangle(sx, sy, ex, ey, block.size));
    }else{
        pts = seqPoints(Placement.normalizeLine(sx, sy, ex, ey));
    }
    let endRotation = -1;
    if(pts.length > 1 && end instanceof ChainedBuilding){
        const s = pts[pts.length - 2];
        if(!(Vars.world.build(s.x, s.y) instanceof ChainedBuilding)) endRotation = end.rotation;
    }
    return {points: pts, diagonal: diagonal, endRotation: endRotation};
}

function setLinePlans(inp, block, nodes, raw, sx, sy, ex, ey, lineRot0){
    const angle = Angles.angle(sx, sy, ex, ey);
    let baseRotation = inp.rotation;
    if(!inp.overrideLineRotation || raw.diagonal){
        baseRotation = (sx == ex && sy == ey) ? inp.rotation : Math.floor((angle + 45) / 90) % 4;
    }
    const plans = inp.linePlans;
    plans.clear();
    let lineRot = lineRot0;
    const ts = Vars.tilesize, w = block.size * ts;
    const lastRect = new Rect(-1, -1, 0, 0), cur = new Rect();
    for(let i = 0; i < nodes.length; i++){
        let point = nodes[i];
        if(cur.setSize(w).setCenter(point.x * ts + block.offset, point.y * ts + block.offset).overlaps(lastRect)) continue;
        let next = i == nodes.length - 1 ? null : nodes[i + 1];
        if((!inp.overrideLineRotation || raw.diagonal) && !block.ignoreLineRotation){
            let result = baseRotation;
            if(next != null){
                result = relativeTo(point.x, point.y, next.x, next.y);
            }else if(raw.endRotation != -1){
                result = raw.endRotation;
            }else if(block.conveyorPlacement && i > 0){
                let prev = nodes[i - 1];
                result = relativeTo(prev.x, prev.y, point.x, point.y);
            }
            if(result != -1) lineRot = result;
        }else{
            lineRot = inp.rotation;
        }
        let plan = new BuildPlan(point.x, point.y, lineRot, block, block.nextConfig());
        plan.animScale = 1;
        plans.add(plan);
        lastRect.setSize(w).setCenter(point.x * ts + block.offset, point.y * ts + block.offset);
    }
    inp.rotation = lineRot;
    fLineRot.setInt(inp.line, lineRot);
}

const SEQ = java.lang.Class.forName("arc.struct.Seq"), BOOL = java.lang.Boolean.TYPE;
const NODE2 = ["mindustry.world.blocks.distribution.ItemBridge", "mindustry.world.blocks.distribution.DirectionBridge",
    "mindustry.world.blocks.power.PowerNode", "mindustry.world.blocks.power.LightBlock"];
const NODE3 = "mindustry.world.blocks.power.BeamNode";
const nodeKinds = Object.create(null);

function nodeKind(block){
    const k = nodeKinds[block.name];
    if(k !== undefined) return k;
    let kind = null;
    try{
        const c = block.getClass();
        const d3 = String(c.getMethod("changePlacementPath", SEQ, INT, BOOL).getDeclaringClass().getName());
        if(d3 == NODE3){
            kind = "3";
        }else if(d3 == "mindustry.world.Block"){
            const d2 = String(c.getMethod("changePlacementPath", SEQ, INT).getDeclaringClass().getName());
            if(NODE2.indexOf(d2) != -1) kind = "2";
        }
    }catch(e){
        report(e);
    }
    nodeKinds[block.name] = kind;
    return kind;
}

function processNodeLine(inp, block, kind, sx, sy, ex, ey, lineRot0){
    const raw = rawPoints(block, sx, sy, ex, ey, null);
    if(kind == "3" && raw.diagonal) return false;
    const pts = raw.points;
    const rotation = inp.rotation;
    const team = Vars.player.team();
    const n = pts.length;

    let affected = false;
    for(let i = 1; i < n - 1 && !affected; i++){
        let p = pts[i];
        if(Build.validPlace(block, team, p.x, p.y, rotation) && !inp.validPlace(p.x, p.y, block, rotation)) affected = true;
    }
    if(!affected) return false;

    const seq = new Seq();
    for(let i = 0; i < n; i++){
        let p = pts[i];
        if(i == 0 || i == n - 1 || inp.validPlace(p.x, p.y, block, rotation)) seq.add(new Point2(p.x, p.y));
    }
    block.changePlacementPath(seq, rotation, raw.diagonal);
    const nodes = seqPoints(seq);

    setLinePlans(inp, block, nodes, raw, sx, sy, ex, ey, lineRot0);
    const plans = inp.linePlans;
    plans.each(cons(plan => {
        const r = plan.block.getReplacement(plan, plans);
        if(r.unlockedNow()) plan.block = r;
    }));
    block.handlePlacementLine(plans);
    return true;
}

const PLACING = PlaceMode.placing;
let ourFirst = null;
let famBlock = null, famCached = null, kindCached = null;
let lastMx = NaN, lastMy = NaN, lastCamX = NaN, lastCamY = NaN, lastScale = NaN;

function refresh(inp){
    if(!Vars.state.isGame() || !(inp instanceof DesktopInput) || !inp.isPlacing()) return;
    const block = inp.block;
    if(block == null) return;
    if(block != famBlock){
        famBlock = block;
        famCached = lineFamily(block);
        kindCached = famCached == null ? nodeKind(block) : null;
        lastMx = NaN;
    }
    const fam = famCached, kind = kindCached;
    if(fam == null && kind == null) return;
    if(!Core.settings.getBool("blockreplace") || Vars.player.unit() == null) return;

    const plans = inp.linePlans;
    const mx = Core.input.mouseX(), my = Core.input.mouseY(), cam = Core.camera.position, scale = Vars.renderer.getScale();
    const ours = plans.size > 0 && plans.first() === ourFirst;
    if(ours && mx == lastMx && my == lastMy && cam.x == lastCamX && cam.y == lastCamY && scale == lastScale) return;
    lastMx = mx; lastMy = my; lastCamX = cam.x; lastCamY = cam.y; lastScale = scale;

    const cx = Number(mTileX[0].invoke(inp, new java.lang.Float(mx)));
    const cy = Number(mTileX[1].invoke(inp, new java.lang.Float(my)));
    if(ours && cx == inp.lastLineX && cy == inp.lastLineY) return;

    const sx = inp.selectX, sy = inp.selectY;
    const lineRot0 = Number(fLineRot.getInt(inp.line));
    try{
        if(fam != null){
            updateLine(inp, sx, sy, cx, cy, false);
            const obs = obstacles(inp);
            let hit = false;
            for(let i = 0; i < plans.size && !hit; i++){
                let p = plans.get(i);
                if(obs.at(p.x, p.y) != null) hit = true;
            }
            if(hit){
                const raw = rawPoints(block, sx, sy, cx, cy, obs);
                let same = raw.points.length == plans.size;
                for(let i = 0; same && i < plans.size; i++){
                    let p = plans.get(i);
                    same = p.x == raw.points[i].x && p.y == raw.points[i].y;
                }
                if(!same) setLinePlans(inp, block, raw.points, raw, sx, sy, cx, cy, lineRot0);
                processLine(inp, fam, obs);
            }else{
                updateLine(inp, sx, sy, cx, cy, true);
            }
        }else{
            if(!processNodeLine(inp, block, kind, sx, sy, cx, cy, lineRot0)) updateLine(inp, sx, sy, cx, cy, true);
        }
    }catch(e){
        report(e);
        try{
            updateLine(inp, sx, sy, cx, cy, true);
        }catch(e2){
            report(e2);
        }
    }
    inp.lastLineX = cx;
    inp.lastLineY = cy;
    ourFirst = plans.size > 0 ? plans.first() : null;
}

function guarded(){
    const inp = Vars.control.input;
    if(inp.mode != PLACING){
        famBlock = null;
        return;
    }
    if(mUpdateLine == null || !Core.settings.getBool(PREF_ON, true)) return;
    try{
        refresh(inp);
    }catch(e){
        report(e);
    }
}

Events.run(Trigger.update, guarded);
Events.run(Trigger.preDraw, guarded);

cur1e.settings({mod: "line-bridge", title: "line-bridge.settings.title", icon: "distribution", build: t => {
    t.checkPref(PREF_ON, true);
}});

Log.info(TAG + " loaded");
