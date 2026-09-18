export function createSampleData() {
  const p1 = 'paper_ml_001'
  const p2 = 'paper_ml_002'
  const p3 = 'paper_sys_001'
  const p4 = 'paper_sec_001'
  const r1 = 'rev_alice'
  const r2 = 'rev_bob'
  const r3 = 'rev_carol'
  const r4 = 'rev_dave'
  return {
    papers: [
      { id: p1, title: '面向大语言模型的高效微调方法', reviewsRequired: 2, tags: ['机器学习', 'NLP'] },
      { id: p2, title: '图神经网络在推荐系统中的应用', reviewsRequired: 2, tags: ['机器学习', '推荐系统'] },
      { id: p3, title: '高并发分布式键值存储的一致性优化', reviewsRequired: 2, tags: ['分布式系统', '数据库'] },
      { id: p4, title: '联邦学习中的隐私泄露攻击与防御', reviewsRequired: 2, tags: ['安全', '机器学习'] }
    ],
    reviewers: [
      { id: r1, name: 'Alice（机器学习）', organization: '清华大学', tags: ['机器学习', 'NLP', '计算机视觉'], capacity: 2, conflictPaperIds: [p1] },
      { id: r2, name: 'Bob（推荐/ML）', organization: '北京大学', tags: ['机器学习', '推荐系统', 'NLP'], capacity: 2, conflictPaperIds: [] },
      { id: r3, name: 'Carol（系统/数据库）', organization: '清华大学', tags: ['分布式系统', '数据库', '存储'], capacity: 3, conflictPaperIds: [p3] },
      { id: r4, name: 'Dave（安全/隐私）', organization: '中科院软件所', tags: ['安全', '隐私', '机器学习'], capacity: 2, conflictPaperIds: [] }
    ],
    preAssignments: []
  }
}
