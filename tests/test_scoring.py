"""計分與文章庫的單元測試，不需要啟動伺服器。"""

from server import scoring, texts


def test_normalize_removes_spaces_and_converts_punctuation():
    assert scoring.normalize("你好, 世界!\n再見.") == "你好，世界！再見。"


def test_correct_prefix_length_stops_at_first_mistake():
    assert scoring.correct_prefix_length("天地玄黃", "天地玄黃宇宙") == 4
    assert scoring.correct_prefix_length("天地元黃", "天地玄黃") == 2
    assert scoring.correct_prefix_length("", "天地") == 0


def test_is_complete_requires_exact_match():
    assert scoring.is_complete("天地", "天地")
    assert not scoring.is_complete("天", "天地")
    assert not scoring.is_complete("天地人", "天地")


def test_cpm():
    assert scoring.cpm(100, 60) == 100.0
    assert scoring.cpm(50, 30) == 100.0
    assert scoring.cpm(10, 0) == 0.0


def test_articles_are_loaded_and_normalized():
    assert texts.CATEGORIES, "至少要有一個分類"
    for articles in texts.CATEGORIES.values():
        for article in articles:
            assert article == scoring.normalize(article)


def test_pick_random_avoids_previous_article():
    category = texts.default_category()
    articles = texts.CATEGORIES[category]
    if len(articles) > 1:
        for _ in range(20):
            assert texts.pick_random(category, exclude=articles[0]) != articles[0]
