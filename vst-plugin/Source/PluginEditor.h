#pragma once

#include "PluginProcessor.h"

class EchoDriftAudioProcessorEditor : public juce::AudioProcessorEditor
{
public:
    explicit EchoDriftAudioProcessorEditor (EchoDriftAudioProcessor&);
    ~EchoDriftAudioProcessorEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    EchoDriftAudioProcessor& processorRef;

    juce::Slider delayTimeSlider, feedbackSlider, mixSlider, toneSlider;
    juce::Label delayTimeLabel, feedbackLabel, mixLabel, toneLabel;

    using SliderAttachment = juce::AudioProcessorValueTreeState::SliderAttachment;
    std::unique_ptr<SliderAttachment> delayTimeAttachment, feedbackAttachment, mixAttachment, toneAttachment;

    void setupSlider (juce::Slider& slider, juce::Label& label, const juce::String& text);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EchoDriftAudioProcessorEditor)
};
