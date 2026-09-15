# 逐页截图 paper-show/index.html → shots/slide-XX.png (1920x1080)
import asyncio, os, sys
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "shots")
os.makedirs(OUT, exist_ok=True)
URL = "file:///" + os.path.join(HERE, "index.html").replace("\\", "/")

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1920, "height": 1080})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(2500)  # fonts + entrance
        n = await page.locator(".slide").count()
        print("slides:", n)
        for i in range(n):
            slide = page.locator(".slide").nth(i)
            await slide.scroll_into_view_if_needed()
            await page.wait_for_timeout(1200)
            # 触发 .in 入场态
            await page.evaluate(f"""() => {{
                const s = document.querySelectorAll('.slide')[{i}];
                s.classList.add('in');
            }}""")
            await page.wait_for_timeout(900)
            path = os.path.join(OUT, f"slide-{i+1:02d}.png")
            await page.screenshot(path=path)
            print("shot", path)
        if errors:
            print("PAGE ERRORS:")
            for e in errors:
                print("  ", e[:300])
        else:
            print("no page errors")
        await browser.close()

asyncio.run(main())
