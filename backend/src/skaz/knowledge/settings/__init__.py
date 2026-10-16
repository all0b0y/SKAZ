"""Settings of the new interface (``/kb/settings/*``, area S3) over the existing stores.

Nothing here keeps its own copy of a setting: keys stay in the app's secret
store, speech choices in the legacy settings document, the decision layer in
D1, agents in A2, the library in the knowledge service. These modules read
them together and run the explicit fixes the settings screens offer.
"""
