/**
 * Background Job: Update Source Quality Scores (P3-5)
 *
 * Computes Source.quality_score from like/dislike interactions on each
 * source's articles published in the last 30 days. Designed to run
 * daily — quality shifts slowly, no need for sub-day cadence.
 *
 * Formula:
 *   raw_quality = 1 - dislikes / (likes + dislikes + SMOOTHING)
 *
 * SMOOTHING (=20) prevents new sources with few interactions from being
 * penalized as outliers. With 0 likes and 0 dislikes, raw_quality = 1.0
 * (neutral). It takes a sustained dislike pattern (e.g. 40 dislikes vs
 * 0 likes) to drop quality below 0.7.
 *
 * SCHEDULING (Cloud Scheduler):
 *   gcloud scheduler jobs create http update-source-quality \
 *     --schedule="30 2 * * *" \
 *     --uri="https://YOUR_BACKEND/api/jobs/update-source-quality" \
 *     --http-method=POST \
 *     --headers="x-api-key=YOUR_ADMIN_API_KEY"
 */

const Article = require('../models/Article');
const Source = require('../models/Source');

const SMOOTHING = 20;
const LOOKBACK_DAYS = 30;

async function updateSourceQualityScores() {
  const startTime = Date.now();
  console.log(`🚀 Starting source quality update at ${new Date().toISOString()}`);

  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    // Aggregate like/dislike counts per source over the last N days.
    const rows = await Article.aggregate([
      { $match: { publishedAt: { $gte: since } } },
      {
        $group: {
          _id: '$sourceId',
          totalLikes: { $sum: { $ifNull: ['$likes', 0] } },
          totalDislikes: { $sum: { $ifNull: ['$dislikes', 0] } },
          articles: { $sum: 1 },
        },
      },
    ]);

    console.log(`📊 Computing quality for ${rows.length} sources`);

    let updated = 0;
    const now = new Date();
    for (const row of rows) {
      if (!row._id) continue;
      const denom = row.totalLikes + row.totalDislikes + SMOOTHING;
      const quality = Math.max(0, Math.min(1, 1 - row.totalDislikes / denom));
      await Source.updateOne(
        { _id: row._id },
        { $set: { quality_score: quality, quality_score_updated_at: now } }
      );
      updated++;
      if (quality < 0.7) {
        console.log(
          `📉 Low quality source ${row._id}: ${quality.toFixed(3)} ` +
          `(${row.totalLikes} likes / ${row.totalDislikes} dislikes / ${row.articles} articles)`
        );
      }
    }

    // Sources that had no articles in the window: leave their previous
    // score alone. They'll be re-evaluated whenever they next publish.

    const duration = Date.now() - startTime;
    console.log(`✅ Updated ${updated} source quality scores in ${duration}ms`);

    return { success: true, updated, processed: rows.length, durationMs: duration };
  } catch (error) {
    console.error('❌ Error in updateSourceQualityScores:', error);
    return { success: false, error: error.message };
  }
}

module.exports = { updateSourceQualityScores };
