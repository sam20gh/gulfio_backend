router.post('/comments', async (req, res) => {
    const { articleId, userId, username, comment } = req.body;
    if (!articleId || !userId || !comment) return res.status(400).send("Missing fields");

    await db.collection('comments').insertOne({
        articleId: new ObjectId(articleId),
        userId,
        username,
        comment,
        createdAt: new Date()
    });

    res.status(201).send({ message: 'Comment added' });
});
router.get('/comments/:articleId', async (req, res) => {
    const { articleId } = req.params;
    const comments = await db.collection('comments')
        .find({ articleId: new ObjectId(articleId) })
        .sort({ createdAt: -1 })
        .toArray();

    res.send(comments);
});
router.delete('/comments/:commentId', async (req, res) => {
    const { commentId } = req.params;
    if (!commentId) return res.status(400).send("Missing comment ID");

    await db.collection('comments').deleteOne({ _id: new ObjectId(commentId) });
    res.status(200).send({ message: 'Comment deleted' });
});
router.put('/comments/:commentId', async (req, res) => {
    const { commentId } = req.params;
    const { comment } = req.body;
    if (!commentId || !comment) return res.status(400).send("Missing fields");

    await db.collection('comments').updateOne(
        { _id: new ObjectId(commentId) },
        { $set: { comment } }
    );

    res.status(200).send({ message: 'Comment updated' });
});