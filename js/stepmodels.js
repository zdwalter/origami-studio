/*
 * stepmodels.js — step-by-step tutorials for the "分步折叠" mode.
 * Coordinates of each op are in the folded-plane frame at that step (y down, initial sheet [0,w]x[0,h]).
 * op: {type:'fold', a, b, side:[x,y] (a point on the flap that moves), kind:'valley'|'mountain', scope:'all'|'top'|'bottom'}
 *     {type:'flip'} | {type:'rotate', deg}
 */
(function (global) {
  'use strict';
  var S2 = Math.SQRT1_2, T225 = Math.tan(Math.PI / 8);
  function F(title, description, a, b, side, kind, scope) { return { title: title, description: description, op: { type: 'fold', a: a, b: b, side: side, kind: kind || 'valley', scope: scope || 'all' } }; }
  function flip(title, d) { return { title: title || '翻面', description: d || '把纸整个翻过来。', op: { type: 'flip' } }; }
  function rot(deg, title, d) { return { title: title || '旋转', description: d || '把纸在桌面上旋转摆正。', op: { type: 'rotate', deg: deg } }; }

  var models = [];

  // ---------------------------------------------------------------- 纸飞机（经典飞镖）
  (function () {
    var bx = 0.5 - T225; // where the 22.5° folds meet the bottom edge
    models.push({
      id: 'plane', name: '纸飞机（经典飞镖）', difficulty: 1, frontColor: '#3e7bfa',
      displayAngles: { 4: 174, 5: 150, 6: 150 },
      description: '最经典的尖头纸飞机：两次把斜边折到中线，再对折并折出机翼。',
      width: 1, height: 1,
      steps: [
        F('折左上角', '将左上方的上边沿谷折到竖直中线上，左上角落在纸的中心。', [0.5, 0], [0, 0.5], [0.08, 0.08]),
        F('折右上角', '同样把右上方的上边沿折到中线上，形成尖尖的“屋顶”。', [0.5, 0], [1, 0.5], [0.92, 0.08]),
        F('再折左斜边', '把左侧新的斜边再次折到中线上，机头变得更尖。', [0.5, 0], [bx, 1], [0.04, 0.6]),
        F('再折右斜边', '右侧同理，斜边对齐中线。', [0.5, 0], [1 - bx, 1], [0.96, 0.6]),
        F('沿中线对折', '沿中线山折，左半边折到背后，折好的翻片都留在外侧。', [0.5, 0], [0.5, 1], [0.3, 0.7], 'mountain'),
        F('折下前机翼', '只取最上面一层，沿平行于机身的线向下折出机翼。', [0.62, 0], [0.62, 1], [0.8, 0.9], 'valley', 'top'),
        F('折下后机翼', '背面的一层向后折出另一侧机翼，与前翼对称。完成！', [0.62, 0], [0.62, 1], [0.8, 0.9], 'mountain', 'bottom')
      ]
    });
  })();

  // ---------------------------------------------------------------- 报纸帽
  (function () {
    var w = S2, c = w / 2, y1 = 0.5 + c; // corners land at (c, y1)
    models.push({
      id: 'hat', name: '报纸帽（头盔）', difficulty: 1, frontColor: '#f2b632',
      description: '用一张长方形纸（1:√2）折一顶可以戴的帽子。',
      width: w, height: 1,
      steps: [
        F('上下对折', '把上半张纸向下谷折，与下边对齐。折痕在上方。', [0, 0.5], [w, 0.5], [c, 0.2]),
        F('折左角', '把左上角向下折到中线上，斜边从顶部中点出发。', [c, 0.5], [0, y1], [0.03, 0.53]),
        F('折右角', '右上角同样折到中线，形成三角形帽顶。', [c, 0.5], [w, y1], [w - 0.03, 0.53]),
        F('折起前帽檐', '只把最上面一层的下边条向上折，盖住两个三角形的下缘。', [0, y1], [w, y1], [c, 0.95], 'valley', 'top'),
        F('折起后帽檐', '背面的一层下边条向后折。撑开下口就可以戴上啦！', [0, y1], [w, y1], [c, 0.95], 'mountain', 'bottom')
      ]
    });
  })();

  // ---------------------------------------------------------------- 纸杯
  (function () {
    // After the diagonal fold + rotation: base y = 0.5 from x = 0.5-√½ to 0.5+√½, apex (0.5, 0.5-√½).
    // Corner fold line makes 67.5° with the base so the flap's top edge ends horizontal at y = 1.5-√2
    // and the corner lands exactly on the opposite slanted edge.
    var yTop = 1.5 - Math.SQRT2, xa = S2 - 0.5, xb = 2.5 - 3 * S2;
    models.push({
      id: 'cup', name: '纸杯', difficulty: 2, frontColor: '#1f9d72',
      description: '一只真的可以装水（一小会儿）的纸杯：三角形、两角交叉、两片尖角向下。',
      width: 1, height: 1,
      steps: [
        F('对角对折', '沿对角线谷折，把左上半张折到右下半张上，得到三角形。', [1, 0], [0, 1], [0.1, 0.1]),
        rot(-135, '摆正三角形', '旋转纸张，使折边在下、直角尖朝上。'),
        F('左角折向右边', '把左下角折到右侧斜边上，让翻片的上边保持水平。', [xa, yTop], [xb, 0.5], [0.5 - S2 + 0.03, 0.49]),
        F('右角折向左边', '同样把右下角折到左侧斜边上，与刚才的翻片交叉。', [1 - xa, yTop], [1 - xb, 0.5], [0.5 + S2 - 0.03, 0.49]),
        F('前片尖角向下', '只把最前面一层的尖角向下折（真实折法中把它塞进前面的口袋）。', [-0.3, yTop], [1.3, yTop], [0.5, 0.5 - S2 + 0.03], 'valley', 'top'),
        F('后片尖角向后', '背面一层的尖角向后折。从上方撑开杯口，纸杯完成！', [-0.3, yTop], [1.3, yTop], [0.5, 0.5 - S2 + 0.03], 'mountain', 'bottom')
      ]
    });
  })();

  // ---------------------------------------------------------------- 小狗脸
  (function () {
    var apex = 0.5 + S2, L = 0.5 - S2, R = 0.5 + S2;
    models.push({
      id: 'dog', name: '小狗脸', difficulty: 1, frontColor: '#b07a4f',
      description: '幼儿园经典：一个三角形折出耷拉的耳朵和鼻子，画上眼睛就是小狗。',
      width: 1, height: 1,
      steps: [
        F('对角对折', '沿对角线把左下半张向上谷折，得到三角形。', [0, 0], [1, 1], [0.1, 0.9]),
        rot(135, '尖角朝下', '旋转纸张，长边在上、尖角朝下。'),
        F('折左耳', '把左边的角斜着向下折，形成一只耷拉的耳朵。', [0.30, 0.5], [L + 0.15, 0.65], [L + 0.03, 0.51]),
        F('折右耳', '右边的角同样向下折出另一只耳朵。', [0.70, 0.5], [R - 0.15, 0.65], [R - 0.03, 0.51]),
        F('折鼻子', '把最上一层的下尖角向上折一小段，做成鼻子。', [-0.2, apex - 0.16], [1.2, apex - 0.16], [0.5, apex - 0.03], 'valley', 'top'),
        F('折下巴', '背面那层的尖角向后折，让脸型更圆。画上眼睛就完成了！', [-0.2, apex - 0.1], [1.2, apex - 0.1], [0.5, apex - 0.02], 'mountain', 'bottom')
      ]
    });
  })();

  // ---------------------------------------------------------------- 东南西北
  (function () {
    var steps = [
      F('左上角折向中心', '把四个角依次折到纸的中心点。先折左上角。', [0.5, 0], [0, 0.5], [0.05, 0.05]),
      F('右上角折向中心', '右上角折到中心。', [0.5, 0], [1, 0.5], [0.95, 0.05]),
      F('右下角折向中心', '右下角折到中心。', [1, 0.5], [0.5, 1], [0.95, 0.95]),
      F('左下角折向中心', '左下角折到中心，得到一个小一圈的正方形（坐垫基本型）。', [0.5, 1], [0, 0.5], [0.05, 0.95]),
      flip('翻面', '把整张纸翻过来，光滑的一面朝上。'),
      F('上角折向中心', '再次把四个角折向中心。先折上角。', [0, 0.25], [1, 0.25], [0.5, 0.03]),
      F('下角折向中心', '下角折到中心。', [0, 0.75], [1, 0.75], [0.5, 0.97]),
      F('左角折向中心', '左角折到中心。', [0.25, 0], [0.25, 1], [0.03, 0.5]),
      F('右角折向中心', '右角折到中心，得到四个小正方形。', [0.75, 0], [0.75, 1], [0.97, 0.5]),
      flip('再翻面', '翻过来，可以看到四个可以翻开的方块，在里面写上“东南西北”吧！')
    ];
    models.push({ id: 'fortune', name: '东南西北（平面阶段）', difficulty: 2, frontColor: '#d94f8a', description: '童年游戏“东南西北”的折法：两轮四角向心折。最后撑开四个口袋即可玩耍（立体撑开步骤未模拟）。', width: 1, height: 1, steps: steps });
  })();

  // ---------------------------------------------------------------- 折扇
  (function () {
    var n = 8, steps = [];
    for (var k = n - 1; k >= 1; k--) {
      var x = k / n, valley = (n - 1 - k) % 2 === 0;
      steps.push(F((valley ? '谷折' : '山折') + ' 第 ' + (n - k) + ' 折', valley ? '把右侧所有层向前（朝你）折过来。' : '把右侧所有层向后折过去。', [x, 0], [x, 0.5], [x + 0.06, 0.25], valley ? 'valley' : 'mountain'));
    }
    steps[steps.length - 1].description += ' 把一端捏紧，展开另一端就是一把扇子！';
    models.push({ id: 'fan', name: '折扇（手风琴折）', difficulty: 1, frontColor: '#7a4bd1', description: '一前一后来回折叠的手风琴褶，是扇子、灯笼、弹簧的基础。', width: 1, height: 0.5, steps: steps });
  })();

  // ---------------------------------------------------------------- 正方形分割练习
  models.push({
    id: 'quarters', name: '四等分练习', difficulty: 1, frontColor: '#e8553d',
    description: '练习“仅顶层”折法：两次对折成四层后，只翻折最上面一层的散开角。',
    width: 1, height: 1,
    steps: [
      F('左右对折', '把右半边谷折到左半边上。', [0.5, 0], [0.5, 1], [0.8, 0.5]),
      F('上下对折', '再把下半边向上折，得到四层的小正方形。', [0, 0.5], [0.5, 0.5], [0.25, 0.8]),
      F('折顶层的角', '左上角是四层纸的散开角。只把最上一层折向对角（封闭的角无法单独折一层）。', [0, 0.5], [0.5, 0], [0.05, 0.05], 'valley', 'top'),
      flip('翻面', '翻过来看看背面。'),
      F('折背面的角', '同样只折最上一层的散开角。', [0, 0], [0.5, 0.5], [0.45, 0.05], 'valley', 'top')
    ]
  });

  // ---------------------------------------------------------------- 滑翔机（长方形纸）
  (function () {
    models.push({
      id: 'glider', name: '滑翔机（长方形纸）', difficulty: 3, frontColor: '#63a83a',
      displayAngles: { 5: 168 },
      // 展开展示：沿「沿中线对折」那条机身线把两翼对称打开，两翼之间夹角 = angle
      displayOpen: { step: 8, angle: 90 },
      description: '用一张长方形纸（1:√2，A4 比例）折的滑翔机：中折痕 → 两个上角折到中线 → 两条斜边折到中线 → 机头折下 → 对折 → 两侧机翼分别沿斜线折下（只折连通的整叠翻片）。',
      width: Math.SQRT1_2, height: 1,
      steps: [
        { title: '折出中折痕', description: '沿中线下折压出折痕再展开。', op: { type: 'crease', a: [0.354, 0], b: [0.354, 1], side: [0.274, 0.25] } },
        { title: '折左上角', description: '左上角沿 45° 折线折到中线上。', op: { type: 'fold', a: [0.354, 0], b: [0, 0.354], side: [0.02, 0.02] } },
        { title: '折右上角', description: '右上角同样折到中线，顶部变成尖三角。', op: { type: 'fold', a: [0.354, 0], b: [0.707, 0.354], side: [0.687, 0.02] } },
        { title: '折左边', description: '把左侧斜边沿角平分线折到中线上，机身变窄。', op: { type: 'fold', a: [0.354, 0], b: [-0.794, 2.772], side: [0.02, 0.5] } },
        { title: '折右边', description: '右侧同样折到中线。', op: { type: 'fold', a: [0.354, 0], b: [1.502, 2.772], side: [0.687, 0.5] } },
        { title: '折下机头', description: '把尖头向下折，尖端落在两侧折角的底边交点上。', op: { type: 'fold', a: [0, 0.25], b: [0.707, 0.25], side: [0.354, 0.005] } },
        { title: '翻面', description: '把纸整个翻过来。', op: { type: 'flip' } },
        { title: '翻面', description: '再翻一次，回到原来那一面。', op: { type: 'flip' } },
        { title: '沿中线对折', description: '沿中折痕把纸对折，成为窄窄的一条。', op: { type: 'fold', a: [0.354, 0], b: [0.354, 1], side: [0.125, 0.552], scope: 'topSheet' } },
        { title: '折下右侧机翼（90°）', description: '从机头斜向尾缘把右侧机翼折到与机身成 90°。', op: { type: 'fold', a: [0.354, 0], b: [0.549, 0.981], side: [0.582, 0.551], scope: 'topSheet', angle: 90 } },
        { title: '翻面', description: '翻到另一面。', op: { type: 'flip' } },
        { title: '折下左侧机翼（90°）', description: '同样把左侧机翼折到 90°，滑翔机完成。', op: { type: 'fold', a: [0.707, 0], b: [0.512, 0.981], side: [0.479, 0.551], scope: 'topSheet', angle: 90 } },
      ]
    });
  })();

  // ---------------------------------------------------------------- 滑翔机 #2（A4 长方形纸）
  // 11 步原样取自用户按图纸折好后导出的工程文件（steps 数组，含折角 165°/120°）。
  // 每个折叠阶段的折痕（含山谷方向）都与该工程文件的 doc.lines 逐条比对一致，见 tests/test-stepfold.js。
  (function () {
    models.push({
      id: 'glider2', name: '滑翔机 #2（A4 长方形纸）', difficulty: 3, frontColor: '#e8553d',
      displayAngles: { 8: 165, 9: 120, 11: 120 },
      description: '图纸 9 格：中线 → 两上角折到中线 → 机头尖角折下 → 放射状收两侧 → 翻面 → 沿中线折 165° → 两侧机翼各折起 120°。',
      width: Math.SQRT1_2, height: 1,
      steps: [
        { title: '折出中线', description: '沿中线对折压出折痕，再展开。', op: { type: 'crease', a: [0.353553, 0], b: [0.353553, 1], side: [0.12, 0.5], kind: 'valley', scope: 'all' } },
        { title: '折左上角', description: '左上角沿 45° 斜线折到中线上。', op: { type: 'fold', a: [0.353553, 0], b: [0, 0.353553], side: [0.03, 0.03], kind: 'valley', scope: 'all' } },
        { title: '折右上角', description: '右上角同样折到中线，顶部成尖角。', op: { type: 'fold', a: [0.353553, 0], b: [0.707107, 0.353553], side: [0.677107, 0.03], kind: 'valley', scope: 'all' } },
        { title: '机头尖角折下', description: '把机头尖角沿 y≈0.46 的水平折痕折下来，两个上角留在原位。', op: { type: 'fold', a: [0, 0.46], b: [0.707107, 0.46], side: [0.353553, 0.06], kind: 'valley', scope: 'all' } },
        { title: '收左下角', description: '沿过机头尖角的斜线把左下角收进来。', op: { type: 'fold', a: [0.529718, 0.282917], b: [-0.176164, 0.990024], side: [0, 0.46], kind: 'valley', scope: 'all' } },
        { title: '收右下角', description: '右侧对称，同样收到中线上。', op: { type: 'fold', a: [0.883271, 0.990024], b: [0.177389, 0.282917], side: [0.707107, 0.46], kind: 'valley', scope: 'all' } },
        { title: '翻面', description: '把纸整个翻过来。', op: { type: 'flip' } },
        { title: '沿中线对折（165°）', description: '沿中线把另一半折到背后，折到 165° 留一点厚度。', op: { type: 'fold', a: [0.353553, 0.813554], b: [0.353553, 1.813554], side: [0, 0.906777], kind: 'valley', scope: 'all', angle: 165 } },
        { title: '折起前机翼（120°）', description: '只取最上层，沿过尖角的折线把机翼折起 120°。', op: { type: 'fold', a: [0.353553, 0.459387], b: [0.735836, 1.383432], side: [0.530636, 0.636777], kind: 'valley', scope: 'topSheet', angle: 120 } },
        { title: '翻面', description: '翻到另一面。', op: { type: 'flip' } },
        { title: '折起后机翼（120°）', description: '另一侧机翼同样折起 120°。完成！', op: { type: 'fold', a: [0.706495, 0.46], b: [0.325013, 1.384376], side: [0.530024, 0.636777], kind: 'valley', scope: 'topSheet', angle: 120 } },
      ]
    });
  })();
  // ---------------------------------------------------------------- 鸭翼滑翔机（Canard，A4 长方形纸）
  // 17 步原样取自用户折好后导出的工程文件（steps 数组，含 165° / 85° / 80° 折角）。
  // 坐标保留完整双精度：折线贴着纸边时，四舍五入会改变切分结果。
  (function () {
    models.push({
      id: 'canard', name: '鸭翼滑翔机（Canard）', difficulty: 3, frontColor: '#3aa757',
      displayAngles: { 13: 165, 14: 85, 16: 80 },
      description: '图纸 9 格的鸭翼纸飞机：中线 → 两上角 → 翻面 → 两侧收边 → 折前鸭翼 → 机头折下 → 压出鸭翼折痕 → 沿中线 165° → 两侧机翼 85°/80°。步骤取自实际折叠数据。',
      width: Math.SQRT1_2, height: 1,
      steps: [
        { title: '折出中线', description: '沿中线压出折痕再展开（用「压痕」按钮一步就能做）。', op: { type: 'crease', a: [0.353553, 0.0], b: [0.353553, 1.0], side: [0.176777, 0.5], kind: 'valley', scope: 'all' } },
        { title: '折左上角', description: '左上角折到中线上，机头变尖。', op: { type: 'fold', a: [0.353553, 0.0], b: [0.0, 0.353553], side: [0.03, 0.03], kind: 'valley', scope: 'all' } },
        { title: '折右上角', description: '右上角同样折到中线。', op: { type: 'fold', a: [0.353553, 0.0], b: [0.707107, 0.353553], side: [0.677107, 0.03], kind: 'valley', scope: 'all' } },
        { title: '翻面', description: '把纸整个翻过来。', op: { type: 'flip' } },
        { title: '收左下角', description: '左下角沿斜线收到中线上。', op: { type: 'fold', a: [0.353554, 0.0], b: [-0.029132, 0.923879], side: [0.176777, 0.176776], kind: 'valley', scope: 'all' } },
        { title: '收右下角', description: '右下角同理，两侧对称。', op: { type: 'fold', a: [0.353554, 0.0], b: [0.736236, 0.92388], side: [0.53033, 0.176777], kind: 'valley', scope: 'all' } },
        { title: '翻面', description: '翻面。', op: { type: 'flip' } },
        { title: '折前鸭翼（右）', description: '只取最上层，沿斜线折出前鸭翼的一侧。', op: { type: 'fold', a: [0.35355284527585396, 1.5472414582884397e-07], b: [0.7071067811865474, 0.8535486429239637], side: [0.42736193772931197, 0.33856070070107397], kind: 'valley', scope: 'topSheet' } },
        { title: '折前鸭翼（左）', description: '另一侧鸭翼同样折出。', op: { type: 'fold', a: [-2.220446049250313e-16, 0.8535555460738357], b: [0.35355262646319363, 3.7353680615304086e-07], side: [0.2870783849995983, 0.24051429184069212], kind: 'valley', scope: 'topSheet' } },
        { title: '翻面', description: '翻面。', op: { type: 'flip' } },
        { title: '机头折下', description: '把机头部分沿水平线折下来。', op: { type: 'fold', a: [0.8535523229630233, 0.25000133544401937], b: [-0.14644551574621845, 0.24999833098421378], side: [0.35355415472335383, 3.7353680615304086e-07], kind: 'valley', scope: 'all' } },
        { title: '压出鸭翼折痕', description: '只取最上层，压出鸭翼的折痕（折好即展开）。', op: { type: 'fold', a: [-0.05092333271986765, 0.2993571974364407], b: [0.7567519199854313, 0.29680376199376374], side: [0.353552652493451, 0.4999992928914269], kind: 'valley', scope: 'topSheet' } },
        { title: '翻面', description: '翻面。', op: { type: 'flip' } },
        { title: '沿中线对折（165°）', description: '沿中线山折到 165°，机身变薄但仍留有厚度。', op: { type: 'fold', a: [0.35355339059327356, 1.0], b: [0.35355339059327356, 0.0], side: [-2.220446049250313e-16, 0.9267777730369178], kind: 'valley', scope: 'all', angle: 165 } },
        { title: '折起右机翼（85°）', description: '只取最上层，把右机翼折起 85°。', op: { type: 'fold', a: [0.4695010982142787, 1.3882350436906647], b: [0.42192659287644513, 0.34266330112592314], side: [0.7071067811865474, 0.8535555460738357], kind: 'valley', scope: 'topSheet', angle: 85 } },
        { title: '翻面', description: '翻面。', op: { type: 'flip' } },
        { title: '折起左机翼（80°）', description: '另一侧机翼折起 80°，两侧形成上反角。完成！', op: { type: 'fold', a: [0.4695080013641505, 0.34265984955098694], b: [0.4219196897265739, 1.3882315921157289], side: [0.1843209099041767, 0.8535486429239637], kind: 'valley', scope: 'topSheet', angle: 80 } },
      ]
    });
  })();
  // ---------------------------------------------------------------- 三角翼（Delta，A4 长方形纸）
  // 原样取自用户折好后导出的工程文件（16 步，含 160° / 80° 折角）。
  // 其中「折一下再打开」的成对步骤合并成一次压痕：折痕与最终几何完全等价
  // （逐顶点偏差 5.6e-16），但 3D 折叠树才能正确演出来。
  (function () {
    models.push({
      id: 'delta', name: '三角翼（Delta）', difficulty: 3, frontColor: '#e8553d',
      displayAngles: { 10: 160, 11: 80, 13: 80 },
      description: '三角翼纸飞机：左右各折一道留折痕 → 压出横中线 → 下边折上 → 两个斜折 → 再折一道 → 沿中线 160° → 两侧机翼 80°。步骤取自实际折叠数据。',
      width: Math.SQRT1_2, height: 1,
      steps: [
        { title: '翻面', description: '把纸翻过来，让要折的一面朝上。', op: { type: 'flip' } },
        { title: '左边折到中线（折完打开，留折痕）', description: '左边折到中线上，再打开，留下折痕。', op: { type: 'crease', a: [0.3535533905932738, 0.0], b: [0.3535533905932738, 1.0], side: [0.0, 0.5], kind: 'valley', scope: 'all' } },
        { title: '右边折到中线（折完打开，留折痕）', description: '右边同样折到中线上再打开。', op: { type: 'crease', a: [0.5303300858899107, 1.0], b: [0.5303300858899107, 0.0], side: [0.7071067811865476, 0.5], kind: 'valley', scope: 'all' } },
        { title: '翻面', description: '翻面。', op: { type: 'flip' } },
        { title: '压出横中线', description: '压出横向中线的折痕。', op: { type: 'crease', a: [0.7071067811865476, 0.5], b: [-0.2928932188134524, 0.5], side: [0.3535533905932738, 0.0], kind: 'valley', scope: 'all' } },
        { title: '下边折到上方', description: '把下边折到上方。', op: { type: 'fold', a: [-0.1464466094067262, 0.75], b: [0.8535533905932737, 0.75], side: [0.3535533905932738, 1.0], kind: 'valley', scope: 'all' } },
        { title: '折右侧斜边', description: '沿斜线把右侧折过来。', op: { type: 'fold', a: [-0.0338674863486495, 0.06724028202754961], b: [0.56652826618715, 1.1325618417045504], side: [0.0, 0.75], kind: 'valley', scope: 'all' } },
        { title: '折左侧斜边', description: '另一侧同样沿斜线折。', op: { type: 'fold', a: [0.12995103444756645, 1.1259784737260745], b: [0.7526174502490766, 0.06268831837317035], side: [0.7071067811865476, 0.75], kind: 'valley', scope: 'all' } },
        { title: '再折一道横线', description: '再折一道横向的折。', op: { type: 'fold', a: [-0.058839127705156535, 0.541608922707228], b: [0.7610352970327221, 0.5470618283377897], side: [0.3497348582561424, 0.7493039817069785], kind: 'valley', scope: 'all' } },
        { title: '翻面', description: '翻面。', op: { type: 'flip' } },
        { title: '沿中线对折（160°）', description: '沿中线对折到 160°，机身留一点厚度。', op: { type: 'fold', a: [0.3535533905932738, 0.14040416292441538], b: [0.3535533905932738, -0.8595958370755846], side: [0.0, 0.07020208146220769], kind: 'valley', scope: 'all', angle: 160 } },
        { title: '折起右机翼（80°）', description: '只取最上层，把右机翼折起 80°。', op: { type: 'fold', a: [0.3535533905932738, 0.7546665523368017], b: [0.6073519598462856, -0.21259054184505244], side: [0.5898178666964125, 0.3354469973759138], kind: 'valley', scope: 'topSheet', angle: 80 } },
        { title: '翻面', description: '翻面。', op: { type: 'flip' } },
        { title: '折左机翼（80°）', description: '另一侧机翼同样折起 80°。完成！', op: { type: 'fold', a: [0.7006894285284604, 0.7546665523368018], b: [0.4468908592754485, -0.21259054184505233], side: [0.4644249524253217, 0.3354469973759138], kind: 'valley', scope: 'topSheet', angle: 80 } },
      ]
    });
  })();

  function list() { return models.map(function (m) { return { id: m.id, name: m.name, difficulty: m.difficulty, description: m.description, steps: m.steps.length }; }); }
  function get(id) { for (var i = 0; i < models.length; i++) if (models[i].id === id) return JSON.parse(JSON.stringify(models[i])); return null; }
  global.StepModels = { list: list, get: get };
})(typeof window !== 'undefined' ? window : globalThis);
