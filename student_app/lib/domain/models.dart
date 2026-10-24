import 'dart:convert';
import 'dart:typed_data';

typedef Json = Map<String, dynamic>;

/// SHA-256 of the exact persisted file bytes, without a platform-only dependency.
String uploadDigest(Uint8List bytes) {
  const constants = [
    0x428a2f98,
    0x71374491,
    0xb5c0fbcf,
    0xe9b5dba5,
    0x3956c25b,
    0x59f111f1,
    0x923f82a4,
    0xab1c5ed5,
    0xd807aa98,
    0x12835b01,
    0x243185be,
    0x550c7dc3,
    0x72be5d74,
    0x80deb1fe,
    0x9bdc06a7,
    0xc19bf174,
    0xe49b69c1,
    0xefbe4786,
    0x0fc19dc6,
    0x240ca1cc,
    0x2de92c6f,
    0x4a7484aa,
    0x5cb0a9dc,
    0x76f988da,
    0x983e5152,
    0xa831c66d,
    0xb00327c8,
    0xbf597fc7,
    0xc6e00bf3,
    0xd5a79147,
    0x06ca6351,
    0x14292967,
    0x27b70a85,
    0x2e1b2138,
    0x4d2c6dfc,
    0x53380d13,
    0x650a7354,
    0x766a0abb,
    0x81c2c92e,
    0x92722c85,
    0xa2bfe8a1,
    0xa81a664b,
    0xc24b8b70,
    0xc76c51a3,
    0xd192e819,
    0xd6990624,
    0xf40e3585,
    0x106aa070,
    0x19a4c116,
    0x1e376c08,
    0x2748774c,
    0x34b0bcb5,
    0x391c0cb3,
    0x4ed8aa4a,
    0x5b9cca4f,
    0x682e6ff3,
    0x748f82ee,
    0x78a5636f,
    0x84c87814,
    0x8cc70208,
    0x90befffa,
    0xa4506ceb,
    0xbef9a3f7,
    0xc67178f2,
  ];
  int rotate(int value, int count) =>
      ((value >>> count) | (value << (32 - count))) & 0xffffffff;
  final padded = Uint8List(((bytes.length + 9 + 63) ~/ 64) * 64)
    ..setRange(0, bytes.length, bytes);
  padded[bytes.length] = 0x80;
  final view = ByteData.sublistView(padded);
  view.setUint32(padded.length - 8, bytes.length ~/ 0x20000000);
  view.setUint32(padded.length - 4, (bytes.length * 8) & 0xffffffff);
  final hash = [
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ];
  for (var offset = 0; offset < padded.length; offset += 64) {
    final words = List<int>.filled(64, 0);
    for (var i = 0; i < 16; i++) {
      words[i] = view.getUint32(offset + i * 4);
    }
    for (var i = 16; i < 64; i++) {
      final x = words[i - 15], y = words[i - 2];
      words[i] =
          (words[i - 16] +
              (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
              words[i - 7] +
              (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) &
          0xffffffff;
    }
    var a = hash[0],
        b = hash[1],
        c = hash[2],
        d = hash[3],
        e = hash[4],
        f = hash[5],
        g = hash[6],
        h = hash[7];
    for (var i = 0; i < 64; i++) {
      final t1 =
          (h +
              (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
              ((e & f) ^ ((~e) & g)) +
              constants[i] +
              words[i]) &
          0xffffffff;
      final t2 =
          ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
              ((a & b) ^ (a & c) ^ (b & c))) &
          0xffffffff;
      h = g;
      g = f;
      f = e;
      e = (d + t1) & 0xffffffff;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & 0xffffffff;
    }
    final result = [a, b, c, d, e, f, g, h];
    for (var i = 0; i < 8; i++) {
      hash[i] = (hash[i] + result[i]) & 0xffffffff;
    }
  }
  return hash.map((value) => value.toRadixString(16).padLeft(8, '0')).join();
}

class CampusTask {
  CampusTask(Json wire) : wire = Map<String, dynamic>.unmodifiable(wire);
  final Json wire;
  String get id => wire['task_id'] as String;
  String get title => wire['title'] as String;
  String get description => wire['description'] as String;
  int get requirementVersion => wire['requirement_version'] as int;
  Json get state =>
      Map<String, dynamic>.from(wire['student_state'] as Map? ?? {});
  String get status => state['display_status'] as String? ?? 'unavailable';
  List<String> get actions =>
      List<String>.from(state['allowed_actions'] as List? ?? []);
  String? get effectiveSubmission =>
      state['effective_submission_id'] as String?;
  Json get deadline => Map<String, dynamic>.from(wire['deadline'] as Map);
  List<Json> get requirements => (wire['requirements'] as List)
      .map((e) => Map<String, dynamic>.from(e as Map))
      .toList();
  String get audience => (wire['audience'] as Map)['description'] as String;
  String get deadlineLabel {
    if (deadline['kind'] == 'unknown') return '截止时间待核实';
    if (deadline['kind'] == 'no_deadline') return '无截止时间';
    final at = DateTime.tryParse(deadline['due_at'] as String? ?? '');
    if (at == null) return '截止时间待核实';
    final local = at.toUtc().add(const Duration(hours: 8));
    String two(int number) => number.toString().padLeft(2, '0');
    return '${local.month}月${local.day}日 ${two(local.hour)}:${two(local.minute)}';
  }
}

const statusLabels = <String, String>{
  'unread': '待阅读',
  'awaiting_confirmation': '待确认',
  'awaiting_submission': '待交材料',
  'submitted_pending_review': '已提交 · 待审核',
  'needs_revision': '需要补正',
  'approved': '审核通过',
  'completed': '已完成',
  'withdrawn': '已撤销',
  'archived': '已归档',
};

String statusLabel(String value) => statusLabels[value] ?? '状态待核对';

class PendingOperation {
  PendingOperation({
    required this.key,
    required this.action,
    required this.targetId,
    required this.path,
    required Json body,
    this.journalFormat = 2,
    this.contractVersion = '0.2.0',
    Json? multipart,
    Json? recovery,
  }) : body = Map<String, dynamic>.unmodifiable(
         jsonDecode(jsonEncode(body)) as Map,
       ),
       multipart = multipart == null
           ? null
           : Map<String, dynamic>.unmodifiable(
               jsonDecode(jsonEncode(multipart)) as Map,
             ),
       recovery = recovery == null
           ? null
           : Map<String, dynamic>.unmodifiable(
               jsonDecode(jsonEncode(recovery)) as Map,
             );
  final String key;
  final String action;
  final String targetId;
  final String path;
  final Json body;
  // Local recovery metadata only; these fields never become HTTP body fields.
  final int journalFormat;
  final String contractVersion;
  final Json? multipart;
  final Json? recovery;
  bool get canReplayUpload =>
      action == 'upload_file' &&
      contractVersion == '0.2.0' &&
      journalFormat >= 2 &&
      multipart != null &&
      recovery != null &&
      body['task_id'] == targetId &&
      body['purpose'] == 'submission_material';
  Uint8List originalUploadBytes() {
    if (!canReplayUpload) throw StateError('旧上传记录缺少经过验证的恢复协议，不能自动重发。');
    final value = multipart!;
    final bytes = base64Decode(value['bytes_base64'] as String);
    if (bytes.length != value['size'] ||
        uploadDigest(bytes) != value['content_sha256']) {
      throw StateError('原文件恢复内容校验失败，请保留原操作并查询结果。');
    }
    return bytes;
  }

  Json toJson() => {
    'key': key,
    'action': action,
    'target_id': targetId,
    'path': path,
    'body': body,
    'journal_format': journalFormat,
    'contract_version': contractVersion,
    if (multipart != null) 'multipart': multipart,
    if (recovery != null) 'recovery': recovery,
  };
  factory PendingOperation.fromJson(Json value) => PendingOperation(
    key: value['key'] as String,
    action: value['action'] as String,
    targetId: value['target_id'] as String,
    path: value['path'] as String,
    body: Map<String, dynamic>.from(value['body'] as Map),
    journalFormat: value['journal_format'] as int? ?? 1,
    contractVersion: value['contract_version'] as String? ?? 'legacy_unknown',
    multipart: value['multipart'] is Map
        ? Map<String, dynamic>.from(value['multipart'] as Map)
        : null,
    recovery: value['recovery'] is Map
        ? Map<String, dynamic>.from(value['recovery'] as Map)
        : null,
  );
}
