import fitz

doc = fitz.open("main.pdf")
for index, page in enumerate(doc):
    for image in page.get_image_info():
        box = image["bbox"]
        width = box[2] - box[0]
        height = box[3] - box[1]
        if width > 200 and height > 40:
            print(
                "page %2d  %.0f x %.0f pt  (y %.0f..%.0f)"
                % (index + 1, width, height, box[1], box[3])
            )
