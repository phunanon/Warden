WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY channelSf
      ORDER BY at DESC
    ) AS rn
  FROM Message
)
DELETE FROM Message
WHERE id IN (
  SELECT id FROM ranked WHERE rn > 16
);
